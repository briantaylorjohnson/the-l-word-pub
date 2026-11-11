const SLOT_NAMES: Record<number, string> = {
  0: 'Head',
  1: 'Neck',
  2: 'Shoulder',
  3: 'Shirt',
  4: 'Chest',
  5: 'Waist',
  6: 'Legs',
  7: 'Boots',
  8: 'Wrist',
  9: 'Gloves',
  10: 'Ring 1',
  11: 'Ring 2',
  12: 'Trinket 1',
  13: 'Trinket 2',
  14: 'Back',
  15: 'Main Hand',
  16: 'Off Hand',
  17: 'Ranged',
  18: 'Tabard',
};

export function slotName(slot: number): string {
  return SLOT_NAMES[slot] ?? `Slot ${slot}`;
}
