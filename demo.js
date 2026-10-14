// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [],
  viewport: { width: 1100, height: 340 },
  async before() {},
  async prepare(context) {
    const { state, open } = context;
    state.editor = await open("usage/signal.js");
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Select the contents of matching brackets.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          state.editor.setCursorBufferPosition([0, 22]);
          lumine.commands.dispatch(
            lumine.views.getView(state.editor),
            "bracket-matcher:select-inside-brackets",
          );
        }
      },
      ready(context) {
        const { state } = context;
        return Boolean(state.editor.getSelectedText().includes("0.2, 0.8"));
      },
    },
  ],
  async cleanup() {},
};
