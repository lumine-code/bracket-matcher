const { CompositeDisposable } = require("lumine");

describe("bracket-matcher marker layer", () => {
  let editor, mainModule, provider, layer, layers, api, consumerDisposable;

  // Minimal stand-in for the layer object a renderer passes to `initialize` and
  // `getItems` (see lib/layer.js in the marker package).
  function makeLayer(targetEditor) {
    const fake = {
      editor: targetEditor,
      props: provider,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
    };
    fake.update = jasmine.createSpy("update").and.callFake(() => {
      const items = provider.getItems(fake);
      if (items) {
        fake.items = items;
      }
    });
    fake.updateSync = fake.update;
    if (provider.initialize) {
      provider.initialize(fake);
    }
    layers.push(fake);
    return fake;
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    mainModule = pack.mainModule;
    provider = mainModule.provideMarkerLayer();
    api = mainModule.provideBracketMatcher();

    // Activation wired the layer to the package's own facade; disconnect that
    // so the specs below control the subscription explicitly.
    mainModule.markerLayerConnection.dispose();

    editor = await lumine.workspace.open();
    editor.setText("(hello)\nworld\n{\n  body\n}\n");
    layers = [];
    layer = makeLayer(editor);
    consumerDisposable = mainModule.markerLayer.connect(api);
  });

  afterEach(() => {
    consumerDisposable.dispose();
    for (const each of layers) {
      each.disposables.dispose();
    }
  });

  it("activates and provides a marker layer descriptor", () => {
    expect(lumine.packages.isPackageActive("bracket-matcher")).toBe(true);
    expect(provider.name).toBe("brackets");
    expect(typeof provider.description).toBe("string");
    expect(provider.enabled).toBe("bracket-matcher.marker.enabled");
    expect(typeof provider.getItems).toBe("function");
  });

  it("matches the shape of the package's own bracket-matcher service", () => {
    expect(typeof api.getMatchRanges).toBe("function");
    expect(typeof api.observe).toBe("function");
    expect(api.getMatchRanges(editor)).toBeNull();
  });

  it("marks a single row when the matched pair sits on one line", () => {
    editor.setCursorBufferPosition([0, 0]);
    expect(layer.update).toHaveBeenCalled();
    expect(layer.items).toEqual([{ row: 0 }]);
  });

  it("marks both rows of a multi-line bracket pair", () => {
    editor.setCursorBufferPosition([2, 0]);
    expect(layer.items).toEqual([{ row: 2 }, { row: 4 }]);
  });

  it("clears the markers when the cursor leaves the bracket pair", () => {
    editor.setCursorBufferPosition([2, 0]);
    expect(layer.items.length).toBe(2);
    editor.setCursorBufferPosition([1, 2]);
    expect(layer.items).toEqual([]);
  });

  it("forgets the editor once its layer detaches", () => {
    expect(mainModule.markerLayer.layers.get(editor)).toBe(layer);
    layer.disposables.dispose();
    expect(mainModule.markerLayer.layers.has(editor)).toBe(false);
  });

  it("stops updating the layer once the consumer is disposed", () => {
    const { Emitter } = require("lumine");
    const emitter = new Emitter();
    const fakeApi = {
      getMatchRanges: () => null,
      observe: (callback) => emitter.on("match", (e) => callback(e, null)),
    };
    const disposable = mainModule.markerLayer.connect(fakeApi);
    layer.update.calls.reset();
    emitter.emit("match", editor);
    expect(layer.update).toHaveBeenCalled();

    disposable.dispose();
    layer.update.calls.reset();
    emitter.emit("match", editor);
    expect(layer.update).not.toHaveBeenCalled();
  });
});
