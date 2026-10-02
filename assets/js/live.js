// Live video between the camera app and the dashboard, straight from device
// to device (WebRTC) with the cloud channel only carrying the handshake.
// Nothing passes through a server, so the picture is smooth and private.
// When a direct connection cannot be made (unusual router), the dashboard
// asks the camera for one JPEG per second over the channel instead.

const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
const RTC = () => globalThis.RTCPeerConnection;

/** Camera side: one peer connection per dashboard that asked for the picture. */
export class LivePublisher {
  constructor(cloud, { getStream, onChange } = {}) {
    this.cloud = cloud;
    this.getStream = getStream;
    this.onChange = onChange || (() => {});
    this.peers = new Map();
    this.off = cloud.on('rtc', (m) => this._onRtc(m).catch((e) => console.warn('live', e.message)));
    this.offPresence = cloud.onPresence((p) => {
      const alive = new Set(p.dashboards.map((d) => d.id));
      for (const id of [...this.peers.keys()]) if (!alive.has(id)) this._close(id);
    });
  }

  get supported() {
    return !!RTC();
  }

  get viewers() {
    return this.peers.size;
  }

  async _onRtc(m) {
    if (!m || (m.to && m.to !== this.cloud.id && m.to !== 'camera')) return;
    if (m.kind === 'want') return this._offer(m.from);
    const pc = this.peers.get(m.from);
    if (!pc) return;
    if (m.kind === 'answer' && m.sdp) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.kind === 'ice' && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
    else if (m.kind === 'bye') this._close(m.from);
  }

  async _offer(viewerId) {
    const stream = this.getStream?.();
    if (!stream || !this.supported) return;
    this._close(viewerId);
    const pc = new (RTC())(ICE);
    this.peers.set(viewerId, pc);
    this.onChange(this.viewers);
    for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.cloud.send('rtc', { kind: 'ice', to: viewerId, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this._close(viewerId);
    };
    const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    this.cloud.send('rtc', { kind: 'offer', to: viewerId, sdp: pc.localDescription.sdp });
  }

  /** The camera stream changed (camera restarted): offer again to everyone watching. */
  refresh() {
    for (const id of [...this.peers.keys()]) this._offer(id).catch(() => {});
  }

  _close(id) {
    const pc = this.peers.get(id);
    if (!pc) return;
    this.peers.delete(id);
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    this.onChange(this.viewers);
  }

  closeAll({ tell = true } = {}) {
    for (const id of [...this.peers.keys()]) {
      if (tell) this.cloud.send('rtc', { kind: 'bye', to: id });
      this._close(id);
    }
  }

  destroy() {
    this.closeAll();
    this.off?.();
    this.offPresence?.();
  }
}

/** Dashboard side: asks the camera for its picture and plays it in a <video>. */
export class LiveViewer {
  constructor(cloud, { video, onState } = {}) {
    this.cloud = cloud;
    this.video = video;
    this.onState = onState || (() => {});
    this.pc = null;
    this.state = 'idle'; // idle | connecting | connected | failed
    this.retryTimer = null;
    this.off = cloud.on('rtc', (m) => this._onRtc(m).catch((e) => console.warn('live', e.message)));
  }

  get supported() {
    return !!RTC();
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  /** Ask the camera for the stream (safe to call repeatedly). */
  request() {
    if (!this.supported || !this.cloud.presence.camera) return;
    if (this.state === 'connected' || this.state === 'connecting') return;
    this._set('connecting');
    this.cloud.send('rtc', { kind: 'want', to: 'camera' });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.state === 'connecting') {
        this._teardown();
        this._set('failed');
      }
    }, 15000);
  }

  async _onRtc(m) {
    if (!m || (m.to && m.to !== this.cloud.id)) return;
    if (m.kind === 'offer' && m.sdp) {
      this._teardown();
      const pc = new (RTC())(ICE);
      this.pc = pc;
      this._set('connecting');
      pc.ontrack = (e) => {
        if (this.video && e.streams?.[0]) {
          this.video.srcObject = e.streams[0];
          this.video.play?.().catch(() => {});
        }
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) this.cloud.send('rtc', { kind: 'ice', to: m.from, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(this.retryTimer);
          this._set('connected');
        } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          this._teardown();
          this._set('failed');
        }
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.cloud.send('rtc', { kind: 'answer', to: m.from, sdp: pc.localDescription.sdp });
      return;
    }
    if (!this.pc) return;
    if (m.kind === 'ice' && m.candidate) await this.pc.addIceCandidate(m.candidate).catch(() => {});
    else if (m.kind === 'bye') {
      this._teardown();
      this._set('idle');
    }
  }

  _teardown() {
    clearTimeout(this.retryTimer);
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    if (this.video && this.video.srcObject) this.video.srcObject = null;
  }

  stop() {
    if (this.pc) this.cloud.send('rtc', { kind: 'bye', to: 'camera' });
    this._teardown();
    this._set('idle');
  }

  destroy() {
    this.stop();
    this.off?.();
  }
}
