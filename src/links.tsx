const ARMORY_REALM = 'dreamscythe';

export function ArmoryLink({ characterName, color }: { characterName: string; color?: string }) {
  const url = `https://classic-armory.org/character/us/tbc-anniversary/${ARMORY_REALM}/${encodeURIComponent(characterName)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="armory-link"
      title={`${characterName} on Classic Armory`}
      style={color ? { color } : undefined}
    >
      {characterName}
      <i className="ni ni-curved-next" />
    </a>
  );
}

export function WowheadItemLink({ itemId, itemName }: { itemId: number; itemName: string }) {
  const url = `https://www.wowhead.com/tbc/item=${itemId}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="wowhead-link">
      {itemName}
      <i className="ni ni-curved-next" />
    </a>
  );
}
