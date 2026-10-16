import { IconButton } from './Icon';
import { voiceControlState } from './voiceControls';
import type { Voice } from './voice';

export function VoiceToggle({ kind, voice, disabled = false, savedDeafened, caption = false }: {
  kind: 'mic' | 'headphones'; voice: Voice | null; disabled?: boolean; savedDeafened?: boolean; caption?: boolean;
}) {
  const control = voiceControlState(kind, voice, savedDeafened);
  return <IconButton icon={kind} off={control.off} label={control.label} title={control.title}
    className="vbtn chip" data-state={control.state} aria-pressed={control.off}
    disabled={disabled || !voice || (kind === 'mic' && !!voice.micError && !voice.deafened)}
    onClick={() => voice?.[control.action]()}>{caption && <small>{control.caption}</small>}</IconButton>;
}
