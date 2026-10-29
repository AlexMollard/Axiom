import {createGraphSimulation} from './graph-physics.mjs';

self.onmessage = ({data: {nodes, edges}}) => {
  const simulation = createGraphSimulation(nodes, edges);
  simulation.tick(240);
  self.postMessage({positions: nodes.map(({x, y, vx, vy}) => ({x, y, vx, vy})), alpha: simulation.alpha()});
};
