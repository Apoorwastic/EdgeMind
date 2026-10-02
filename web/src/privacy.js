// The three levels a note can have, and how each one is shown.
//   device     This device only — never leaves this device, not even encrypted
//   private    Private — only you; on a signed-in account it syncs, encrypted, to your other devices
//   shareable  Team — everyone in the team it's shared with
// `cls` reuses the purple "private" styling for both personal levels; "device" adds a gold accent.
export const LEVELS = {
  device: { label: 'This device', icon: 'chip', cls: 'private device' },
  private: { label: 'Private', icon: 'lock', cls: 'private' },
  shareable: { label: 'Team', icon: 'users', cls: 'shared' },
}

export const isPersonal = (m) => !!m && m.sensitivity !== 'shareable'
export const level = (m) => LEVELS[m?.sensitivity] || LEVELS.private
