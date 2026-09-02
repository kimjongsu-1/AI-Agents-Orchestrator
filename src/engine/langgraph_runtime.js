class ConsoleGraphRuntime {
  constructor({ checkpoint }) {
    this.nodes = new Map();
    this.edges = new Map();
    this.checkpoint = checkpoint;
  }

  addNode(name, fn) {
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  async run(startNode, initialState = {}, metadata = {}) {
    let nodeName = startNode;
    let state = { ...initialState };
    const visited = [];

    while (nodeName) {
      const node = this.nodes.get(nodeName);
      if (!node) throw new Error(`Graph node not found: ${nodeName}`);
      visited.push(nodeName);
      if (this.checkpoint) {
        this.checkpoint(nodeName, state, { ...metadata, visited: [...visited], phase: "before" });
      }
      const result = await node(state);
      state = { ...state, ...(result?.state || result || {}) };
      if (this.checkpoint) {
        this.checkpoint(nodeName, state, { ...metadata, visited: [...visited], phase: "after" });
      }
      nodeName = result?.next || this.edges.get(nodeName) || null;
    }

    return state;
  }
}

module.exports = { ConsoleGraphRuntime };
