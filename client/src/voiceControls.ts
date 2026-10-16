type VoiceState = { muted: boolean; deafened: boolean; micError: string | null; mode: 'voice' | 'ptt' };

export function voiceControlState(kind: 'mic' | 'headphones', voice: VoiceState | null, savedDeafened = false) {
  const deaf = voice?.deafened ?? savedDeafened;
  if (kind === 'headphones') return {
    off: deaf, state: deaf ? 'muted' : 'ready', action: 'toggleDeafen' as const,
    label: deaf ? 'Undeafen' : 'Deafen', caption: 'Audio',
    title: deaf ? 'Deafened · click to hear again' : 'Deafen · turn off your microphone and all sound',
  };
  const error = voice?.micError, off = !voice || voice.muted || deaf || !!error;
  return {
    off, state: error ? 'err' : off ? 'muted' : 'ready', action: deaf ? 'toggleDeafen' as const : 'toggleMute' as const,
    label: deaf ? 'Undeafen' : error ? 'Microphone unavailable' : off ? 'Unmute microphone' : 'Mute microphone',
    caption: 'Mic',
    title: error ?? (deaf ? 'Deafened · click to hear again' : off ? 'Microphone muted · click to unmute' : voice?.mode === 'ptt' ? 'Push-to-talk · hold Space to talk' : 'Microphone on · click to mute'),
  };
}
