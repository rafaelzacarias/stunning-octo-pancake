/**
 * Contract pool for the recycling-tycoon loop.
 *
 * Pure data + predicates: no rendering, no DOM, no three, no globals. The
 * GameDirector owns all mutable progress; a contract definition never mutates.
 *
 * A contract's `match(evt)` receives a normalised destruction event
 * `{ id, label, category, mass, value }` and returns the amount of progress to
 * add: a number (`mass` for tonnage jobs, `1` for count jobs) or a boolean,
 * which is read as 1/0. Returning 0 means "this item does not count".
 *
 * A contract may also expose `notifyStall(progress) -> number`, called by the
 * director whenever the motor jams. "Clean run" contracts return 0 to reset.
 *
 * Category strings are matched loosely (normalised, substring) and are backed
 * up by an id set, so a contract keeps working whether the sim tags an item as
 * `appliance`, `white goods` or nothing at all.
 */

/** lowercase, strip spaces/underscores/dashes so 'White Goods' -> 'whitegoods'. */
const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/[\s_-]+/g, '') : '');

const num = (v) => (Number.isFinite(v) ? v : 0);

/** True when the event's category contains any token, or its id is listed. */
function tagged(evt, tokens, ids) {
  const cat = norm(evt?.category);
  if (cat) {
    for (const t of tokens) if (cat === t || cat.includes(t)) return true;
  }
  const id = norm(evt?.id);
  return id ? ids.has(id) : false;
}

const APPLIANCE = {
  tokens: ['appliance', 'whitegood', 'kitchen', 'domestic', 'household'],
  ids: new Set(['microwave', 'fridge', 'freezer', 'oven', 'washer', 'washingmachine', 'dishwasher', 'toaster', 'kettle', 'blender']),
};
const ELECTRONICS = {
  tokens: ['electronic', 'ewaste', 'media', 'entertainment', 'consumer'],
  ids: new Set(['tv', 'speaker', 'monitor', 'pc', 'laptop', 'console', 'printer', 'radio', 'amp']),
};
const TOOLS = {
  tokens: ['tool', 'hardware', 'workshop', 'garden', 'machinery'],
  ids: new Set(['toolbox', 'gear', 'drill', 'saw', 'anvil', 'vice', 'wrench', 'lawnmower', 'mower', 'strimmer', 'chainsaw']),
};
const STRUCTURAL = {
  tokens: ['structural', 'construction', 'stock', 'profile', 'building', 'sheet'],
  ids: new Set(['beam', 'pipe', 'rebar', 'sheet', 'angle', 'plate', 'girder', 'tube', 'channel']),
};
const AUTOMOTIVE = {
  tokens: ['auto', 'vehicle', 'car', 'motor'],
  ids: new Set(['engine', 'wheel', 'radiator', 'gearbox', 'axle', 'bumper', 'exhaust', 'alternator', 'brake']),
};
const CONTAINERS = {
  tokens: ['container', 'packaging', 'beverage', 'canstock'],
  ids: new Set(['can', 'bottle', 'tin', 'drum', 'canister', 'barrel']),
};

/**
 * Build a fresh pool of contract definitions.
 *
 * Returns new objects on every call so two directors never share state.
 * @returns {Array<{id:string,title:string,description:string,target:number,reward:number,match:Function,notifyStall?:Function}>}
 */
export function makeContractPool() {
  return [
    {
      id: 'appliances-6',
      title: 'White Goods Run',
      description: 'Shred 6 kitchen appliances',
      target: 6,
      reward: 130,
      match: (evt) => (tagged(evt, APPLIANCE.tokens, APPLIANCE.ids) ? 1 : 0),
    },
    {
      id: 'ewaste-4',
      title: 'E-Waste Purge',
      description: 'Destroy 4 pieces of consumer electronics',
      target: 4,
      reward: 95,
      match: (evt) => (tagged(evt, ELECTRONICS.tokens, ELECTRONICS.ids) ? 1 : 0),
    },
    {
      id: 'tonnage-250',
      title: 'Tonnage Quota',
      description: 'Process 250 kg of scrap',
      target: 250,
      reward: 190,
      match: (evt) => Math.max(0, num(evt?.mass)),
    },
    {
      id: 'tools-5-clean',
      title: 'Tool Shed Clear-Out',
      description: 'Shred 5 tools without stalling the motor',
      target: 5,
      reward: 165,
      match: (evt) => (tagged(evt, TOOLS.tokens, TOOLS.ids) ? 1 : 0),
      notifyStall: () => 0,
    },
    {
      id: 'structural-8',
      title: 'Structural Steel Order',
      description: 'Feed 8 pieces of structural steel',
      target: 8,
      reward: 140,
      match: (evt) => (tagged(evt, STRUCTURAL.tokens, STRUCTURAL.ids) ? 1 : 0),
    },
    {
      id: 'auto-3',
      title: 'Motor Pool Teardown',
      description: 'Destroy 3 automotive parts',
      target: 3,
      reward: 175,
      match: (evt) => (tagged(evt, AUTOMOTIVE.tokens, AUTOMOTIVE.ids) ? 1 : 0),
    },
    {
      id: 'cans-12',
      title: 'Can Crusher',
      description: 'Crush 12 drink cans',
      target: 12,
      reward: 55,
      match: (evt) => (tagged(evt, CONTAINERS.tokens, CONTAINERS.ids) ? 1 : 0),
    },
    {
      id: 'heavy-4',
      title: 'Heavy Metal',
      description: 'Destroy 4 items over 10 kg',
      target: 4,
      reward: 150,
      match: (evt) => (num(evt?.mass) >= 10 ? 1 : 0),
    },
    {
      id: 'clean-run-12',
      title: 'Clean Run',
      description: 'Shred 12 items without stalling',
      target: 12,
      reward: 210,
      match: () => 1,
      notifyStall: () => 0,
    },
    {
      id: 'volume-25',
      title: 'Volume Bonus',
      description: 'Shred 25 items of any kind',
      target: 25,
      reward: 115,
      match: () => 1,
    },
    {
      id: 'lightgauge-10',
      title: 'Light Gauge Run',
      description: 'Shred 10 items under 3 kg',
      target: 10,
      reward: 90,
      match: (evt) => {
        const m = num(evt?.mass);
        return m > 0 && m < 3 ? 1 : 0;
      },
    },
    {
      id: 'payday-250',
      title: 'High-Value Haul',
      description: 'Book $250 of scrap value',
      target: 250,
      reward: 125,
      match: (evt) => Math.max(0, num(evt?.value)),
    },
  ];
}
