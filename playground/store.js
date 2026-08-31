const items = [];

export function add(item) {
  items.push(item);
  return item;
}

export function remove(item) {
  const index = items.indexOf(item);
  if (index === -1) {
    throw new Error('Item not found');
  }

  const [removed] = items.splice(index, 1);
  return removed;
}

export function all() {
  return [...items];
}

export function clear() {
  items.length = 0;
}
