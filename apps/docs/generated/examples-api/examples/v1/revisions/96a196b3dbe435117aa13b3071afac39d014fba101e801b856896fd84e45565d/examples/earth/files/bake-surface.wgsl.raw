// Bakes day albedo (rgb) and night lights (alpha) into an sRGB map.

import { belt, elevation, equirectDirection, fbm3, ridged3, saturate, valueRemap } from "./planet-common.wgsl";

const OCEAN_DEEP = vec3f(0.008, 0.026, 0.078);
const OCEAN_SHALLOW = vec3f(0.022, 0.098, 0.152);
const SHELF = vec3f(0.030, 0.122, 0.150);
const FOREST = vec3f(0.020, 0.058, 0.019);
const GRASS = vec3f(0.070, 0.115, 0.036);
const DESERT = vec3f(0.235, 0.160, 0.076);
const TUNDRA = vec3f(0.128, 0.118, 0.092);
const ROCK = vec3f(0.098, 0.090, 0.080);
const ICE = vec3f(0.720, 0.780, 0.840);

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direction = equirectDirection(uv);
  let height = elevation(direction);
  let latitude = abs(direction.y);
  let land = saturate(valueRemap(height, 0.0, 0.035, 0.0, 1.0));

  let depth = saturate(-height * 12.0);
  var water = mix(SHELF, OCEAN_SHALLOW, saturate(depth * 3.5));
  water = mix(water, OCEAN_DEEP, saturate(depth));

  let aridity = saturate(valueRemap(fbm3(direction * 2.2 + vec3f(63.1, 7.7, 21.3), 4), -0.18, 0.26, 0.0, 1.0));
  let subtropics = belt(latitude, 0.36, 0.32);
  let humid = 1.0 - saturate(valueRemap(latitude, 0.06, 0.40, 0.0, 1.0));
  let polar = saturate(valueRemap(latitude, 0.60, 0.88, 0.0, 1.0));
  let desertness = saturate(aridity * (0.30 + subtropics * 0.95) * 1.3 - 0.18);

  var ground = mix(GRASS, FOREST, saturate(humid * 0.8 + 0.2));
  ground = mix(ground, DESERT, desertness);
  ground = mix(ground, TUNDRA, polar);

  let relief = ridged3(direction * 8.0 + vec3f(2.5), 5);
  let mountains = saturate(valueRemap(relief * saturate(height * 5.0), 0.35, 0.80, 0.0, 1.0));
  ground = mix(ground, ROCK, mountains * 0.7);
  let snowLine = saturate(valueRemap(mountains, 0.65, 0.98, 0.0, 1.0)) * saturate(0.10 + polar * 1.3);
  ground = mix(ground, ICE, snowLine);

  var albedo = mix(water, ground, land);

  let capNoise = fbm3(direction * 6.0 + vec3f(-31.0), 3) * 0.035;
  let capLatitude = latitude + capNoise + land * 0.02;
  let cap = saturate(valueRemap(capLatitude, 0.905, 0.965, 0.0, 1.0));
  albedo = mix(albedo, ICE, cap);

  let settlement = saturate(valueRemap(fbm3(direction * 16.0 + vec3f(101.7, 4.3, 55.9), 4), 0.04, 0.30, 0.0, 1.0));
  let sprawl = saturate(valueRemap(fbm3(direction * 46.0 + vec3f(9.1), 3), 0.00, 0.26, 0.0, 1.0));
  let coastal = 1.0 - saturate(valueRemap(height, 0.0, 0.22, 0.0, 1.0));
  let habitable = (1.0 - polar) * (1.0 - saturate(desertness * 1.1)) * (1.0 - mountains * 0.85);
  let lights = land * habitable * settlement * sprawl * (0.30 + coastal) * 2.0;

  return vec4f(albedo, saturate(lights));
}
