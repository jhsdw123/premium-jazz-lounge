import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 프로젝트 루트: lib/ 의 부모
export const root = resolve(__dirname, '..');

// 데이터 (gitignore 됨)
export const data = resolve(root, 'data');
export const dataTracks = resolve(data, 'tracks');
export const dataOutput = resolve(data, 'output');
export const dataCache = resolve(data, 'cache');
export const dataTemp = resolve(data, 'temp');

// 정적 자원
export const assets = resolve(root, 'assets');
export const lib = resolve(root, 'lib');
export const tools = resolve(root, 'tools');
export const server = resolve(root, 'server');
export const controlPanel = resolve(server, 'control-panel');
export const controlPanelPublic = resolve(controlPanel, 'public');

export default {
  root,
  data, dataTracks, dataOutput, dataCache, dataTemp,
  assets, lib, tools, server, controlPanel, controlPanelPublic,
};
