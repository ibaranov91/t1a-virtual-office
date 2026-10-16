import type { Room } from './map';

export const ROOM_MODES = [
  { id: 'voice', label: 'Voice', hint: 'Walk in to join the room’s voice channel' },
  { id: 'knock', label: 'Knock', hint: 'Knock on someone to start a conversation' },
  { id: 'quiet', label: 'Quiet', hint: 'No room voice or incoming knocks' },
  { id: 'later', label: 'Busy', hint: 'No room voice; knocks wait for later' },
] as const;
export type RoomMode = typeof ROOM_MODES[number]['id'];
export type RoomModes = Partial<Record<string, RoomMode>>;
export const isRoomMode = (mode: unknown): mode is RoomMode => ROOM_MODES.some(m => m.id === mode);
export const roomMode = (room: Pick<Room, 'rules'>): RoomMode => room.rules.voice === 'open' ? 'voice'
  : room.rules.knock === 'allow' ? 'knock' : room.rules.knock === 'later' ? 'later' : 'quiet';

/** Keep access restrictions and original room-specific copy when restoring its generated mode. */
export function rulesForMode(base: Room['rules'], mode?: RoomMode): Room['rules'] {
  if (!mode || roomMode({ rules: base }) === mode) return { ...base };
  const access = base.access;
  switch (mode) {
    case 'voice': return { access, voice: 'open', knock: 'allow', label: 'open voice · walk in to talk' };
    case 'knock': return { access, knock: 'allow', label: 'knock to talk' };
    case 'quiet': return { access, knock: 'disabled', label: 'quiet · no knocks' };
    case 'later': return { access, knock: 'later', occupantLabel: 'busy', label: 'knocks wait for later' };
  }
}
