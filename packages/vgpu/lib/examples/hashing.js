import { createHash } from 'node:crypto';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const field = (value) => `${Buffer.byteLength(value)}:${value}\n`;
export function aggregateSha256(manifest) {
  let value = `vgpu-example-aggregate/v1\0${field(manifest.id)}${field(manifest.title)}${field(manifest.description)}`;
  value += `${manifest.tags.length}\n${manifest.tags.map(field).join('')}${manifest.capabilities.length}\n${manifest.capabilities.map(field).join('')}${manifest.files.length}\n`;
  for (const file of manifest.files) value += `${field(file.path)}${field(file.contentType)}${file.size}\n${file.sha256}\n`;
  return sha256(value);
}
