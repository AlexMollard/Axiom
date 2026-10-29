import {forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY} from 'd3-force';

export function createGraphSimulation(nodes, edges) {
  return forceSimulation(nodes).force('link', forceLink(edges).id(node => node.path).distance(68).strength(0.35))
    .force('charge', forceManyBody().strength(-90).distanceMax(260)).force('collision', forceCollide(23))
    .force('x', forceX(0).strength(0.035)).force('y', forceY(0).strength(0.035)).stop();
}
