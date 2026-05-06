export function remember<K, V>(map: Map<K, V>, key: K, value: V, max = 64): void {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}
