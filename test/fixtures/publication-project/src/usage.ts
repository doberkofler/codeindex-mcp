import {api, load} from './api.js';

export const readValue = api;

export const callValue = load();

export const target = {value: 1};

target.value = 2;

export const wrote = target.value;

export const typed: import('./api.js').Point = {x: 1, y: 2};
