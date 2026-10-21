const { CompositeDisposable } = require("lumine");

describe("bracket-matcher marker layer", () => {
  let editor, mainModule, provider, layer, layers, api, consumerDisposable;
  let waitForMatching;
  async function moveCursor(position) {
    editor.setCursorBufferPosition(position);
    await waitForMatching(editor);
  }

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
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    waitForMatching = require("./helpers/async-matching")(pack);
    mainModule = pack.mainModule;
    provider = mainModule.provideMarkerLayer();
    api = mainModule.provideBracketMatcher();

    // Activation wired the layer to the package's own facade; disconnect that
    // so the specs below control the subscription explicitly.
    mainModule.markerLayerConnection.dispose();

    editor = await lumine.workspace.open();
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
    editor.setText("(hello)\nworld\n{\n  body\n}\n");
    await editor.languageMode.ready;
    await editor.languageMode.atTransactionEnd();
    editor.setCursorBufferPosition([1, 2]);
    await waitForMatching(editor);
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

  it("marks a single row when the matched pair sits on one line", async () => {
    await moveCursor([0, 0]);
    expect(layer.update).toHaveBeenCalled();
    expect(layer.items).toEqual([{ row: 0 }]);
  });

  it("marks both rows of a multi-line bracket pair", async () => {
    await moveCursor([2, 0]);
    expect(layer.items).toEqual([{ row: 2 }, { row: 4 }]);
  });

  it("seeds the current match when a layer attaches after the cursor moved", async () => {
    await moveCursor([2, 0]);
    layer.disposables.dispose();

    const replacement = makeLayer(editor);
    replacement.updateSync();

    expect(replacement.items).toEqual([{ row: 2 }, { row: 4 }]);
  });

  it("seeds existing layers when the bracket service reconnects", async () => {
    consumerDisposable.dispose();
    await moveCursor([2, 0]);
    layer.items = [];

    consumerDisposable = mainModule.markerLayer.connect(api);

    expect(layer.items).toEqual([{ row: 2 }, { row: 4 }]);
  });

  it("places both brackets on their exact screen rows within a wrapped buffer line", async () => {
    editor.setText(`prefix ${"word ".repeat(6)}(${"word ".repeat(12)})`);
    await editor.languageMode.atTransactionEnd();
    editor.setSoftWrapped(true);
    editor.displayLayer.reset({ softWrapColumn: 20 });
    const openColumn = editor.lineTextForBufferRow(0).indexOf("(");
    const closeColumn = editor.lineTextForBufferRow(0).indexOf(")");

    await moveCursor([0, openColumn]);

    const openRow = editor.screenPositionForBufferPosition([0, openColumn]).row;
    const closeRow = editor.screenPositionForBufferPosition([0, closeColumn]).row;
    expect(openRow).toBeGreaterThan(0);
    expect(closeRow).toBeGreaterThan(openRow);
    expect(layer.items).toEqual([{ row: openRow }, { row: closeRow }]);
  });

  it("clears the markers when the cursor leaves the bracket pair", async () => {
    await moveCursor([2, 0]);
    expect(layer.items.length).toBe(2);
    await moveCursor([1, 2]);
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

  it("clears the current match when the service disconnects", async () => {
    await moveCursor([2, 0]);
    expect(layer.items).toEqual([{ row: 2 }, { row: 4 }]);

    consumerDisposable.dispose();

    expect(layer.items).toEqual([]);
    layer.disposables.dispose();
    const replacement = makeLayer(editor);
    replacement.updateSync();
    expect(replacement.items).toEqual([]);
  });

  it("ignores callbacks and cleanup from a replaced connection to the same facade", async () => {
    consumerDisposable.dispose();
    const callbacks = [];
    const observe = api.observe;
    spyOn(api, "observe").and.callFake((callback) => {
      callbacks.push(callback);
      return observe(callback);
    });
    const previous = mainModule.markerLayer.connect(api);
    consumerDisposable = mainModule.markerLayer.connect(api);
    await moveCursor([2, 0]);
    const match = api.getMatchRanges(editor);
    layer.update.calls.reset();

    callbacks[0](editor, null);
    previous.dispose();

    expect(layer.update).not.toHaveBeenCalled();
    expect(layer.items).toEqual([{ row: 2 }, { row: 4 }]);
    consumerDisposable.dispose();
    layer.update.calls.reset();
    callbacks[1](editor, match);
    expect(layer.update).not.toHaveBeenCalled();
    expect(layer.items).toEqual([]);
  });
});
