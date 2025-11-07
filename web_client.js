const elements = {
  iceState: document.getElementById("ice-connection-state"),
  signalingState: document.getElementById("signaling-state"),
  dataChannelState: document.getElementById("datachannel-state"),
  dataChannelLog: document.getElementById("data-channel"),
  dcInput: document.getElementById("dc-input"),
  dcSendBtn: document.getElementById("dc-send"),
  audioCapture: document.getElementById("audio-capture"),
  displaySelect: document.getElementById("display-id"),
  setDisplayBtn: document.getElementById("set-display"),
  connectBtn: document.getElementById("connect"),
  disconnectBtn: document.getElementById("disconnect"),
  media: document.getElementById("media"),
  video: document.getElementById("video"),
};

// Config section (can be overridden by setting window.CROSSDESK_CONFIG before this script runs)
const DEFAULT_CONFIG = {
  signalingUrl: "wss://api.crossdesk.cn:9090",
  iceServers: [
    { urls: ["stun:api.crossdesk.cn:3478"] },
    { urls: ["turn:api.crossdesk.cn:3478"], username: "crossdesk", credential: "crossdeskpw" },
  ],
  heartbeatIntervalMs: 3000,
  heartbeatTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  clientTag: "web",
};
const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.CROSSDESK_CONFIG || {});

const control = window.CrossDeskControl;
let pc = null;
let clientId = "000000";
let heartbeatTimer = null;
let lastPongAt = Date.now();

const websocket = new WebSocket(CONFIG.signalingUrl);

websocket.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  const message = JSON.parse(event.data);

  if (message.type === "pong") {
    lastPongAt = Date.now();
    return;
  }

  handleSignalingMessage(message);
});

websocket.addEventListener("open", () => {
  enableConnectButton(true);
  sendLogin();
  startHeartbeat();
});

websocket.addEventListener("close", () => {
  stopHeartbeat();
  enableConnectButton(false);
});

websocket.addEventListener("error", () => {
  stopHeartbeat();
  scheduleReconnect();
});

function handleSignalingMessage(message) {
  switch (message.type) {
    case "login":
      clientId = message.user_id.split("@")[0];
      break;
    case "offer":
      handleOffer(message);
      break;
    case "new_candidate_mid":
      if (!pc) return;
      pc.addIceCandidate(
        new RTCIceCandidate({
          sdpMid: message.mid,
          candidate: message.candidate,
        })
      ).catch((err) => console.error("Error adding ICE candidate", err));
      break;
    default:
      break;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
    if (Date.now() - lastPongAt > CONFIG.heartbeatTimeoutMs) {
      scheduleReconnect();
    }
  }, CONFIG.heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect() {
  try {
    websocket.close();
  } catch (err) {}
  setTimeout(() => window.location.reload(), CONFIG.reconnectDelayMs);
}

function sendLogin() {
  websocket.send(JSON.stringify({ type: "login", user_id: CONFIG.clientTag }));
}

function handleOffer(offer) {
  pc = createPeerConnection();
  pc.setRemoteDescription(offer)
    .then(() => sendAnswer(pc))
    .catch((err) => console.error("Failed to handle offer", err));
}

function createPeerConnection() {
  const config = {
    iceServers: CONFIG.iceServers,
    iceTransportPolicy: "all",
  };

  const peer = new RTCPeerConnection(config);

  peer.addEventListener("iceconnectionstatechange", () => {
    updateStatus(elements.iceState, peer.iceConnectionState);
  });
  updateStatus(elements.iceState, peer.iceConnectionState);

  peer.addEventListener("signalingstatechange", () => {
    updateStatus(elements.signalingState, peer.signalingState);
  });
  updateStatus(elements.signalingState, peer.signalingState);

  peer.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    websocket.send(
      JSON.stringify({
        type: "new_candidate_mid",
        transmission_id: getTransmissionId(),
        user_id: clientId,
        remote_user_id: getTransmissionId(),
        candidate: candidate.candidate,
        mid: candidate.sdpMid,
      })
    );
  };

  peer.ontrack = ({ track, streams }) => {
    if (track.kind !== "video" || !elements.video) return;
    if (!elements.video.srcObject) {
      const stream = streams && streams[0] ? streams[0] : new MediaStream([track]);
      elements.video.srcObject = stream;
      elements.video.muted = true;
      elements.video.setAttribute("playsinline", "true");
      elements.video.setAttribute("webkit-playsinline", "true");
      elements.video.setAttribute("x5-video-player-type", "h5");
      elements.video.setAttribute("x5-video-player-fullscreen", "true");
      elements.video.autoplay = true;
    } else {
      elements.video.srcObject.addTrack(track);
    }

    if (!elements.displaySelect) return;
    const trackId = track.id || "";
    if (!trackId) return;

    const existingOption = Array.from(elements.displaySelect.options).find(
      (opt) => opt.value === trackId
    );
    if (!existingOption) {
      const option = document.createElement("option");
      option.value = trackId;
      option.textContent = trackId;
      elements.displaySelect.appendChild(option);
    }
    elements.displaySelect.value = trackId;
  };

  peer.ondatachannel = (event) => {
    const channel = event.channel;
    control.setDataChannel(channel);
    bindDataChannel(channel);
  };

  return peer;
}

function bindDataChannel(channel) {
  channel.addEventListener("open", () => {
    updateStatus(elements.dataChannelState, "open");
    enableDataChannelUi(true);
  });

  channel.addEventListener("close", () => {
    updateStatus(elements.dataChannelState, "closed");
    enableDataChannelUi(false);
    control.setDataChannel(null);
  });

  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || !elements.dataChannelLog) return;
    elements.dataChannelLog.textContent += `< ${event.data}\n`;
    elements.dataChannelLog.scrollTop = elements.dataChannelLog.scrollHeight;
  });
}

async function sendAnswer(peer) {
  await peer.setLocalDescription(await peer.createAnswer());
  await waitIceGathering(peer);
  websocket.send(
    JSON.stringify({
      type: "answer",
      transmission_id: getTransmissionId(),
      user_id: clientId,
      remote_user_id: getTransmissionId(),
      sdp: peer.localDescription.sdp,
    })
  );
}

function waitIceGathering(peer) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") resolve();
    });
  });
}

function getTransmissionId() {
  return document.getElementById("transmission-id").value.trim();
}

function getTransmissionPwd() {
  return document.getElementById("transmission-pwd").value.trim();
}

function sendJoinRequest() {
  websocket.send(
    JSON.stringify({
      type: "join_transmission",
      user_id: clientId,
      transmission_id: `${getTransmissionId()}@${getTransmissionPwd()}`,
    })
  );
}

function sendLeaveRequest() {
  websocket.send(
    JSON.stringify({
      type: "leave_transmission",
      user_id: clientId,
      transmission_id: getTransmissionId(),
    })
  );
}

function connect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
  elements.connectBtn.style.display = "none";
  elements.disconnectBtn.style.display = "inline-block";
  elements.media.style.display = "block";
  sendJoinRequest();
}

function disconnect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
  elements.disconnectBtn.style.display = "none";
  elements.connectBtn.style.display = "inline-block";
  elements.media.style.display = "none";

  sendLeaveRequest();
  teardownPeerConnection();
  enableDataChannelUi(false);
  updateStatus(elements.iceState, "");
  updateStatus(elements.signalingState, "");
  updateStatus(elements.dataChannelState, "closed");
}

function teardownPeerConnection() {
  if (!pc) return;

  try {
    pc.getSenders().forEach((sender) => sender.track?.stop?.());
  } catch (err) {}

  pc.close();
  pc = null;

  if (elements.video?.srcObject) {
    elements.video.srcObject.getTracks().forEach((track) => track.stop());
    elements.video.srcObject = null;
  }
}

function updateStatus(element, value) {
  if (!element) return;
  element.textContent = value || "";
}

function enableConnectButton(enabled) {
  if (!elements.connectBtn) return;
  elements.connectBtn.disabled = !enabled;
}

function enableDataChannelUi(enabled) {
  if (elements.audioCapture) {
    elements.audioCapture.disabled = !enabled;
    if (!enabled) {
      elements.audioCapture.checked = false;
      elements.audioCapture.onchange = null;
    } else {
      elements.audioCapture.onchange = (event) =>
        control.sendAudioCapture(!!event.target.checked);
    }
  }

  if (elements.displaySelect) {
    elements.displaySelect.disabled = !enabled;
  }

  if (elements.setDisplayBtn) {
    elements.setDisplayBtn.disabled = !enabled;
  }

  if (elements.dcInput) {
    elements.dcInput.disabled = !enabled;
    if (!enabled) elements.dcInput.value = "";
  }

  if (elements.dcSendBtn) {
    elements.dcSendBtn.disabled = !enabled;
  }
}

function setDisplayId() {
  if (!elements.displaySelect) return;
  const raw = elements.displaySelect.value.trim();
  if (!raw) return;
  const parsed = parseInt(raw, 10);
  const numericValue = Number.isFinite(parsed) ? parsed : 0;
  control.sendDisplayId(numericValue);
}

function sendDataChannelMessage() {
  if (!elements.dcInput) return;
  const text = elements.dcInput.value.trim();
  if (!text) return;

  try {
    const parsed = JSON.parse(text);
    const isObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
    const hasNumericType = isObject && typeof parsed.type === "number";
    const hasPayload =
      parsed.mouse || parsed.keyboard || parsed.audio_capture || parsed.display_id;

    if (!hasNumericType || !hasPayload) {
      alert(
        "Only RemoteAction JSON is supported (must include numeric type and one of mouse/keyboard/audio_capture/display_id)."
      );
      return;
    }

    if (control.sendRawMessage(JSON.stringify(parsed))) {
      elements.dcInput.value = "";
    }
  } catch (err) {
    alert("请输入合法的 JSON。");
  }
}

if (elements.connectBtn) {
  elements.connectBtn.addEventListener("click", connect);
}

if (elements.disconnectBtn) {
  elements.disconnectBtn.addEventListener("click", disconnect);
}

if (elements.setDisplayBtn) {
  elements.setDisplayBtn.addEventListener("click", setDisplayId);
}

if (elements.dcSendBtn) {
  elements.dcSendBtn.addEventListener("click", sendDataChannelMessage);
}

if (elements.dcInput) {
  elements.dcInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendDataChannelMessage();
    }
  });
}

window.connect = connect;
window.disconnect = disconnect;
window.sendDataChannelMessage = sendDataChannelMessage;
window.setDisplayId = setDisplayId;

