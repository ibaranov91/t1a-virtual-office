import { audio } from '../audio';
export class RetroAudio {
  private nodes = new Set<AudioBufferSourceNode>();
  private next = 0;
  constructor(private input: () => AudioNode | null) {}
  play(buffers: Uint8Array[]) {
    const input = this.input(); if (!input) { this.stop(); return; }
    const c = audio();
    if (c.state !== 'running') { this.stop(); return; }
    for (const bytes of buffers) {
      const buffer = c.createBuffer(2, bytes.length / 2, c.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) data[i] = (bytes[i * 2 + channel] - 128) / 128;
      }
      const node = c.createBufferSource(); node.buffer = buffer; node.connect(input);
      node.onended = () => { this.nodes.delete(node); node.disconnect(); };
      this.nodes.add(node); this.next = Math.max(this.next, c.currentTime + .1);
      node.start(this.next); this.next += buffer.duration;
    }
  }
  stop() { for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect(); } this.nodes.clear(); this.next = 0; }
}
