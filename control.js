(function () {
  const ControlType = {
    mouse: 0,
    keyboard: 1,
    audio_capture: 2,
    host_infomation: 3,
    display_id: 4,
  };

  const MouseFlag = {
    move: 0,
    left_down: 1,
    left_up: 2,
    right_down: 3,
    right_up: 4,
    middle_down: 5,
    middle_up: 6,
    wheel_vertical: 7,
    wheel_horizontal: 8,
  };

  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const isTextInput = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  };

  class ControlManager {
    constructor() {
      this.dataChannel = null;
      this.elements = {
        video: document.getElementById("video"),
        dataLog: document.getElementById("data-channel"),
        mediaContainer: document.getElementById("media"),
        videoContainer: document.getElementById("video-container"),
        fullscreenBtn: document.getElementById("fullscreen-btn"),
        realFullscreenBtn: document.getElementById("real-fullscreen-btn"),
        virtualMouse: document.getElementById("virtual-mouse"),
        virtualLeftBtn: document.getElementById("virtual-left-btn"),
        virtualRightBtn: document.getElementById("virtual-right-btn"),
        virtualWheel: document.getElementById("virtual-wheel"),
        virtualTouchpad: document.getElementById("virtual-touchpad"),
        virtualDragHandle: document.getElementById("virtual-mouse-drag-handle"),
      };

      this.state = {
        pointerLocked: false,
        normalizedPos: { x: 0.5, y: 0.5 },
        lastPointerPos: null,
        lastWheelAt: 0,
        isFullscreen: false,
        isRealFullscreen: false,
        touchpadStart: null,
        draggingVirtualMouse: false,
        dragOffset: { x: 0, y: 0 },
        pointerLockToastTimer: null,
        videoRect: null,
      };

      this.virtualWheelTimer = null;

      this.onPointerLockChange = this.onPointerLockChange.bind(this);
      this.onPointerLockError = this.onPointerLockError.bind(this);
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.onPointerCancel = this.onPointerCancel.bind(this);
      this.onWheel = this.onWheel.bind(this);

      this.onTouchStartFallback = this.onTouchStartFallback.bind(this);
      this.onTouchMoveFallback = this.onTouchMoveFallback.bind(this);
      this.onTouchEndFallback = this.onTouchEndFallback.bind(this);

      this.onVirtualWheelStart = this.onVirtualWheelStart.bind(this);
      this.onVirtualWheelEnd = this.onVirtualWheelEnd.bind(this);
      this.onTouchpadStart = this.onTouchpadStart.bind(this);
      this.onTouchpadMove = this.onTouchpadMove.bind(this);
      this.onTouchpadEnd = this.onTouchpadEnd.bind(this);

      this.onDragHandleTouchStart = this.onDragHandleTouchStart.bind(this);
      this.onDragHandleTouchMove = this.onDragHandleTouchMove.bind(this);
      this.onDragHandleTouchEnd = this.onDragHandleTouchEnd.bind(this);
      this.onDragHandleClick = this.onDragHandleClick.bind(this);

      this.init();
    }

    init() {
      const { video } = this.elements;
      if (!video) {
        console.warn("CrossDeskControl: video element not found");
        return;
      }

      video.style.pointerEvents = "auto";
      video.tabIndex = 0;

      this.bindPointerLockEvents();
      this.bindPointerListeners();
      this.bindKeyboardListeners();
      this.setupVirtualMouse();
      this.setupFullscreenButtons();
    }

    setDataChannel(channel) {
      this.dataChannel = channel;
    }

    isChannelOpen() {
      return this.dataChannel && this.dataChannel.readyState === "open";
    }

    send(action) {
      if (!this.isChannelOpen()) return false;
      try {
        const payload = JSON.stringify(action);
        this.dataChannel.send(payload);
        this.logDataChannel(payload);
        return true;
      } catch (err) {
        console.error("CrossDeskControl: failed to send action", err);
        return false;
      }
    }

    sendMouseAction({ x, y, flag, scroll = 0 }) {
      const numericFlag =
        typeof flag === "string" ? MouseFlag[flag] ?? MouseFlag.move : flag | 0;

      const action = {
        type: ControlType.mouse,
        mouse: {
          x: clamp01(x),
          y: clamp01(y),
          s: scroll | 0,
          flag: numericFlag,
        },
      };

      this.send(action);
    }

    sendKeyboardAction(keyValue, isDown) {
      const action = {
        type: ControlType.keyboard,
        keyboard: {
          key_value: keyValue | 0,
          flag: isDown ? 0 : 1,
        },
      };
      this.send(action);
    }

    sendAudioCapture(enabled) {
      const action = {
        type: ControlType.audio_capture,
        audio_capture: !!enabled,
      };
      this.send(action);
    }

    sendDisplayId(id) {
      const action = {
        type: ControlType.display_id,
        display_id: id | 0,
      };
      this.send(action);
    }

    sendRawMessage(raw) {
      if (!this.isChannelOpen()) return false;
      try {
        this.dataChannel.send(raw);
        this.logDataChannel(raw);
        return true;
      } catch (err) {
        console.error("CrossDeskControl: failed to send raw message", err);
        return false;
      }
    }

    logDataChannel(text) {
      const { dataLog } = this.elements;
      if (!dataLog) return;
      dataLog.textContent += `> ${text}\n`;
      dataLog.scrollTop = dataLog.scrollHeight;
    }

    bindPointerLockEvents() {
      document.addEventListener("pointerlockchange", this.onPointerLockChange);
      document.addEventListener("pointerlockerror", this.onPointerLockError);
      document.addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key === "Escape") {
          document.exitPointerLock?.();
        }
      });
    }

    onPointerLockChange() {
      this.state.pointerLocked = document.pointerLockElement === this.elements.video;
      if (this.state.pointerLocked) {
        this.state.videoRect = this.elements.video?.getBoundingClientRect() ?? null;
      } else {
        this.state.videoRect = null;
        this.showPointerLockToast(
          "已退出鼠标锁定，按 Esc 或点击视频重新锁定（释放可按 Ctrl+Esc）",
          3000
        );
      }
      if (this.elements.dataLog) {
        this.elements.dataLog.textContent += `[pointerlock ${
          this.state.pointerLocked ? "entered" : "exited"
        }]\n`;
        this.elements.dataLog.scrollTop = this.elements.dataLog.scrollHeight;
      }
    }

    onPointerLockError() {
      this.showPointerLockToast("鼠标锁定失败", 2500);
    }

    bindPointerListeners() {
      const { video } = this.elements;
      if (!video) return;

      try {
        video.style.touchAction = "none";
      } catch (err) {}

      video.addEventListener("pointerdown", this.onPointerDown, {
        passive: false,
      });
      document.addEventListener("pointermove", this.onPointerMove, {
        passive: false,
      });
      document.addEventListener("pointerup", this.onPointerUp, {
        passive: false,
      });
      document.addEventListener("pointercancel", this.onPointerCancel);
      video.addEventListener("wheel", this.onWheel, { passive: false });

      if (!window.PointerEvent) {
        video.addEventListener("touchstart", this.onTouchStartFallback, {
          passive: false,
        });
        document.addEventListener("touchmove", this.onTouchMoveFallback, {
          passive: false,
        });
        document.addEventListener("touchend", this.onTouchEndFallback, {
          passive: false,
        });
        document.addEventListener("touchcancel", this.onTouchEndFallback, {
          passive: false,
        });
      }
    }

    onPointerDown(event) {
      const button = typeof event.button === "number" ? event.button : 0;
      if (button < 0) return;
      event.preventDefault?.();

      this.state.lastPointerPos = { x: event.clientX, y: event.clientY };
      this.ensureVideoRect();
      if (this.state.videoRect && this.isInsideVideo(event.clientX, event.clientY)) {
        this.updateNormalizedFromClient(event.clientX, event.clientY);
        this.requestPointerLock();
      }

      this.elements.video?.setPointerCapture?.(event.pointerId ?? 0);
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: this.buttonToFlag(button, true),
      });
    }

    onPointerMove(event) {
      if (!this.state.pointerLocked && !this.state.lastPointerPos) return;

      const movementX = this.state.pointerLocked
        ? event.movementX
        : event.clientX - (this.state.lastPointerPos?.x ?? event.clientX);
      const movementY = this.state.pointerLocked
        ? event.movementY
        : event.clientY - (this.state.lastPointerPos?.y ?? event.clientY);

      if (!this.state.pointerLocked) {
        this.state.lastPointerPos = { x: event.clientX, y: event.clientY };
      }

      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      if (this.state.pointerLocked) {
        this.state.normalizedPos.x = clamp01(
          this.state.normalizedPos.x + movementX / this.state.videoRect.width
        );
        this.state.normalizedPos.y = clamp01(
          this.state.normalizedPos.y + movementY / this.state.videoRect.height
        );
        this.sendMouseAction({
          x: this.state.normalizedPos.x,
          y: this.state.normalizedPos.y,
          flag: MouseFlag.move,
        });
        return;
      }

      if (!this.isInsideVideo(event.clientX, event.clientY)) return;
      const x = (event.clientX - this.state.videoRect.left) /
        this.state.videoRect.width;
      const y = (event.clientY - this.state.videoRect.top) /
        this.state.videoRect.height;
      this.state.normalizedPos = { x: clamp01(x), y: clamp01(y) };
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.move,
      });
    }

    onPointerUp(event) {
      const button = typeof event.button === "number" ? event.button : 0;
      this.elements.video?.releasePointerCapture?.(event.pointerId ?? 0);
      this.state.lastPointerPos = null;
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: this.buttonToFlag(button, false),
      });
    }

    onPointerCancel() {
      this.state.lastPointerPos = null;
    }

    onWheel(event) {
      const now = Date.now();
      if (now - this.state.lastWheelAt < 50) return;
      this.state.lastWheelAt = now;

      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      let coords = this.state.normalizedPos;
      if (!this.state.pointerLocked) {
        if (!this.isInsideVideo(event.clientX, event.clientY)) return;
        coords = {
          x: (event.clientX - this.state.videoRect.left) /
            this.state.videoRect.width,
          y: (event.clientY - this.state.videoRect.top) /
            this.state.videoRect.height,
        };
      }

      this.sendMouseAction({
        x: coords.x,
        y: coords.y,
        flag: event.deltaY === 0 ? MouseFlag.wheel_horizontal : MouseFlag.wheel_vertical,
        scroll: event.deltaY || event.deltaX,
      });
      event.preventDefault();
    }

    onTouchStartFallback(event) {
      if (!event.touches?.length) return;
      const touch = event.touches[0];
      this.state.lastPointerPos = { x: touch.clientX, y: touch.clientY };
      event.preventDefault();
      this.onPointerDown({
        button: 0,
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
    }

    onTouchMoveFallback(event) {
      if (!this.state.lastPointerPos || !event.touches?.length) return;
      const touch = event.touches[0];
      event.preventDefault();
      this.onPointerMove({
        clientX: touch.clientX,
        clientY: touch.clientY,
        movementX: touch.clientX - this.state.lastPointerPos.x,
        movementY: touch.clientY - this.state.lastPointerPos.y,
      });
      this.state.lastPointerPos = { x: touch.clientX, y: touch.clientY };
    }

    onTouchEndFallback(event) {
      const touch = event.changedTouches?.[0];
      this.onPointerUp({
        button: 0,
        clientX: touch?.clientX ?? 0,
        clientY: touch?.clientY ?? 0,
      });
      this.state.lastPointerPos = null;
    }

    buttonToFlag(button, isDown) {
      const mapping = {
        0: { down: MouseFlag.left_down, up: MouseFlag.left_up },
        1: { down: MouseFlag.middle_down, up: MouseFlag.middle_up },
        2: { down: MouseFlag.right_down, up: MouseFlag.right_up },
      };
      const record = mapping[button] || mapping[0];
      return isDown ? record.down : record.up;
    }

    requestPointerLock() {
      try {
        this.elements.video?.requestPointerLock?.();
      } catch (err) {
        console.warn("CrossDeskControl: requestPointerLock failed", err);
      }
    }

    ensureVideoRect() {
      const { video } = this.elements;
      if (!video) return;
      this.state.videoRect = video.getBoundingClientRect();
    }

    isInsideVideo(clientX, clientY) {
      const rect = this.state.videoRect;
      if (!rect) return false;
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    }

    updateNormalizedFromClient(clientX, clientY) {
      if (!this.state.videoRect) return;
      this.state.normalizedPos = {
        x: clamp01((clientX - this.state.videoRect.left) / this.state.videoRect.width),
        y: clamp01((clientY - this.state.videoRect.top) / this.state.videoRect.height),
      };
    }

    bindKeyboardListeners() {
      document.addEventListener("keydown", (event) => {
        if (!this.isChannelOpen()) return;
        if (event.repeat) return;
        if (isTextInput(event.target)) return;
        this.sendKeyboardAction(event.keyCode ?? 0, true);
      });

      document.addEventListener("keyup", (event) => {
        if (!this.isChannelOpen()) return;
        if (isTextInput(event.target)) return;
        this.sendKeyboardAction(event.keyCode ?? 0, false);
      });
    }

    setupVirtualMouse() {
      const isDesktop = window.matchMedia(
        "(hover: hover) and (pointer: fine)"
      ).matches;

      if (isDesktop) {
        if (this.elements.virtualMouse) {
          this.elements.virtualMouse.style.pointerEvents = "none";
        }
        return;
      }

      this.elements.virtualLeftBtn?.addEventListener(
        "touchstart",
        (event) => {
          event.preventDefault();
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.left_down,
          });
        },
        { passive: false }
      );

      this.elements.virtualLeftBtn?.addEventListener(
        "touchend",
        (event) => {
          event.preventDefault();
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.left_up,
          });
        },
        { passive: false }
      );

      this.elements.virtualRightBtn?.addEventListener(
        "touchstart",
        (event) => {
          event.preventDefault();
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.right_down,
          });
        },
        { passive: false }
      );

      this.elements.virtualRightBtn?.addEventListener(
        "touchend",
        (event) => {
          event.preventDefault();
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.right_up,
          });
        },
        { passive: false }
      );

      this.elements.virtualWheel?.addEventListener(
        "touchstart",
        this.onVirtualWheelStart,
        { passive: false }
      );
      this.elements.virtualWheel?.addEventListener(
        "touchend",
        this.onVirtualWheelEnd,
        { passive: false }
      );
      this.elements.virtualWheel?.addEventListener(
        "touchcancel",
        this.onVirtualWheelEnd,
        { passive: false }
      );

      this.elements.virtualTouchpad?.addEventListener(
        "touchstart",
        this.onTouchpadStart,
        { passive: false }
      );
      this.elements.virtualTouchpad?.addEventListener(
        "touchmove",
        this.onTouchpadMove,
        { passive: false }
      );
      this.elements.virtualTouchpad?.addEventListener(
        "touchend",
        this.onTouchpadEnd,
        { passive: false }
      );
      this.elements.virtualTouchpad?.addEventListener(
        "touchcancel",
        this.onTouchpadEnd,
        { passive: false }
      );

      this.bindVirtualMouseDragging();
    }

    onVirtualWheelStart(event) {
      event.preventDefault();
      this.emitVirtualWheel();
      this.virtualWheelTimer = setInterval(() => this.emitVirtualWheel(), 100);
    }

    onVirtualWheelEnd(event) {
      event.preventDefault();
      if (this.virtualWheelTimer) {
        clearInterval(this.virtualWheelTimer);
        this.virtualWheelTimer = null;
      }
    }

    emitVirtualWheel() {
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.wheel_vertical,
        scroll: -20,
      });
    }

    onTouchpadStart(event) {
      const touch = event.touches?.[0];
      if (!touch) return;
      event.preventDefault();
      this.state.touchpadStart = {
        x: touch.clientX,
        y: touch.clientY,
        normalizedX: this.state.normalizedPos.x,
        normalizedY: this.state.normalizedPos.y,
      };
    }

    onTouchpadMove(event) {
      const touch = event.touches?.[0];
      if (!touch || !this.state.touchpadStart) return;
      event.preventDefault();

      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      const sensitivity = 2;
      const deltaX = touch.clientX - this.state.touchpadStart.x;
      const deltaY = touch.clientY - this.state.touchpadStart.y;

      const newX =
        this.state.touchpadStart.normalizedX +
        (deltaX / this.state.videoRect.width) * sensitivity;
      const newY =
        this.state.touchpadStart.normalizedY +
        (deltaY / this.state.videoRect.height) * sensitivity;

      this.state.normalizedPos = {
        x: clamp01(newX),
        y: clamp01(newY),
      };

      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.move,
      });
    }

    onTouchpadEnd(event) {
      event.preventDefault();
      this.state.touchpadStart = null;
    }

    bindVirtualMouseDragging() {
      const { virtualMouse, virtualDragHandle, videoContainer } = this.elements;
      if (!virtualMouse || !virtualDragHandle || !videoContainer) return;

      virtualDragHandle.addEventListener("touchstart", this.onDragHandleTouchStart, {
        passive: false,
      });
      virtualDragHandle.addEventListener("click", this.onDragHandleClick);
      document.addEventListener("touchmove", this.onDragHandleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onDragHandleTouchEnd, {
        passive: false,
      });
      document.addEventListener("touchcancel", this.onDragHandleTouchEnd, {
        passive: false,
      });
    }

    onDragHandleTouchStart(event) {
      const touch = event.touches?.[0];
      if (!touch || !this.elements.virtualMouse) return;
      event.preventDefault();
      const rect = this.elements.virtualMouse.getBoundingClientRect();
      this.state.draggingVirtualMouse = true;
      this.state.dragOffset = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    }

    onDragHandleTouchMove(event) {
      if (!this.state.draggingVirtualMouse) return;
      const touch = event.touches?.[0];
      if (!touch || !this.elements.videoContainer || !this.elements.virtualMouse)
        return;
      event.preventDefault();

      const containerRect = this.elements.videoContainer.getBoundingClientRect();
      let newX = touch.clientX - this.state.dragOffset.x - containerRect.left;
      let newY = touch.clientY - this.state.dragOffset.y - containerRect.top;

      const maxX = Math.max(
        0,
        containerRect.width - this.elements.virtualMouse.offsetWidth
      );
      const maxY = Math.max(
        0,
        containerRect.height - this.elements.virtualMouse.offsetHeight
      );

      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      this.elements.virtualMouse.style.left = `${newX}px`;
      this.elements.virtualMouse.style.top = `${newY}px`;
      this.elements.virtualMouse.style.bottom = "auto";
      this.elements.virtualMouse.style.transform = "none";
    }

    onDragHandleTouchEnd() {
      this.state.draggingVirtualMouse = false;
    }

    onDragHandleClick(event) {
      event.stopPropagation();
      this.elements.virtualMouse?.classList.toggle("minimized");
    }

    setupFullscreenButtons() {
      this.elements.fullscreenBtn?.addEventListener("click", () => {
        const media = this.elements.mediaContainer;
        if (!media) return;
        this.state.isFullscreen = !this.state.isFullscreen;
        media.classList.toggle("fullscreen", this.state.isFullscreen);
        this.elements.fullscreenBtn.textContent = this.state.isFullscreen
          ? "退出全屏"
          : "最大化";
        this.ensureVideoRect();
      });

      this.elements.realFullscreenBtn?.addEventListener("click", () => {
        const container = this.elements.videoContainer;
        if (!container) return;
        if (!this.state.isRealFullscreen) {
          const request =
            container.requestFullscreen ||
            container.mozRequestFullScreen ||
            container.webkitRequestFullscreen ||
            container.msRequestFullscreen;
          request?.call(container);
        } else {
          const exit =
            document.exitFullscreen ||
            document.mozCancelFullScreen ||
            document.webkitExitFullscreen ||
            document.msExitFullscreen;
          exit?.call(document);
        }
        this.state.isRealFullscreen = !this.state.isRealFullscreen;
        this.elements.realFullscreenBtn.textContent = this.state.isRealFullscreen
          ? "退出全屏"
          : "全屏";
      });
    }

    showPointerLockToast(text, duration = 2500) {
      let toast = document.getElementById("pointerlock-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "pointerlock-toast";
        Object.assign(toast.style, {
          position: "fixed",
          left: "50%",
          bottom: "24px",
          transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.75)",
          color: "#fff",
          padding: "8px 12px",
          borderRadius: "6px",
          fontSize: "13px",
          zIndex: "9999",
          pointerEvents: "none",
          opacity: "1",
          transition: "opacity 0.2s",
        });
        document.body.appendChild(toast);
      }
      toast.textContent = text;
      toast.style.opacity = "1";
      if (this.state.pointerLockToastTimer) {
        clearTimeout(this.state.pointerLockToastTimer);
      }
      this.state.pointerLockToastTimer = setTimeout(() => {
        toast.style.opacity = "0";
        this.state.pointerLockToastTimer = null;
      }, duration);
    }

    handleExternalMouseEvent(event) {
      if (!event || !event.type) return;
      switch (event.type) {
        case "mousedown":
          this.onPointerDown(event);
          break;
        case "mouseup":
          this.onPointerUp(event);
          break;
        case "mousemove":
          this.onPointerMove(event);
          break;
        case "wheel":
          this.onWheel(event);
          break;
        default:
          break;
      }
    }
  }

  const control = new ControlManager();

  window.CrossDeskControl = control;
  window.sendRemoteActionAt = (x, y, flag, scroll) =>
    control.sendMouseAction({ x, y, flag, scroll });
  window.sendMouseEvent = (event) => control.handleExternalMouseEvent(event);
})();

