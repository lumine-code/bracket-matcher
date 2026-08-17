const { Disposable } = require("lumine");

// The `marker.layer` provider: matching bracket positions on the overview maps.
//
// Fed through the package's own `bracket-matcher` service facade, so the layer
// sees exactly what an external consumer of the service would.
module.exports = {
  activate() {
    // One layer per editor: the marker hub builds a single layer per
    // (provider, editor), however many overview maps draw it.
    this.layers = new Map();
  },

  deactivate() {
    this.layers.clear();
  },

  connect(api) {
    const sub = api.observe((editor, match) => {
      const layer = this.layers.get(editor);
      if (layer) {
        layer.cache.set("match", match);
        layer.update();
      }
    });
    return { dispose: () => sub.dispose() };
  },

  provideMarkerLayer() {
    return {
      name: "brackets",
      description: "Matching bracket markers",
      enabled: "bracket-matcher.marker.enabled",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.disposables.add(
          new Disposable(() => {
            this.layers.delete(layer.editor);
          }),
        );
      },
      getItems: ({ editor, cache }) => {
        const match = cache.get("match");
        if (!match) return [];
        const row1 = editor.screenRowForBufferRow(match.range1.start.row);
        const row2 = editor.screenRowForBufferRow(match.range2.start.row);
        const items = [{ row: row1 }];
        if (row2 !== row1) items.push({ row: row2 });
        return items;
      },
    };
  },
};
