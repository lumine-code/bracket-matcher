const { TextBuffer, TextEditor } = require("lumine");

describe("streaming closing tag analysis", () => {
  let find;
  beforeEach(() => {
    jasmine.useRealClock();
    find = require("../lib/source-tag-finder").closingTagForSource;
  });

  function source(text) {
    return { length: text.length, slice: (start, end) => text.slice(start, end) };
  }

  it("agrees with the former parser for unambiguous bounded tag structures", async () => {
    const legacy = new (require("../lib/tag-finder"))();
    for (const name of ["div", "my-element", "xhtml:body", "Foo.Bar", "Foo.Bar.Baz"]) {
      for (const suffix of ["", "plain text", "<child></child>", `</${name}></root>`]) {
        const prefix = `<root><${name} class="a > b" data-other='x'>`;
        expect(await find(source(prefix + suffix), prefix.length, { xmlMode: true })).toBe(
          legacy.closingTagForFragments(prefix, suffix),
        );
      }
    }
  });

  it("skips comments, CDATA, quoted attributes and HTML raw text", async () => {
    for (const [text, xmlMode, expected] of [
      ['<root a="<fake>"><!-- <fake> -->', true, "root"],
      ["<root><![CDATA[<fake>]]>", true, "root"],
      ["<HTML><script>const html = '<fake>'; </script><BODY><input>", false, "BODY"],
      ["<root><input>", true, "input"],
      ["<root><self /></root>", true, null],
    ])
      expect(await find(source(text), text.length, { xmlMode })).toBe(expected);
  });

  it("declines incomplete markup and mismatched closures instead of inventing a closing tag", async () => {
    for (const [prefix, suffix] of [
      ['<root attr="unfinished', '">'],
      ["<root><!-- unfinished", " -->"],
      ["<root><child>", "</root>"],
      ["<root>", '<child attr="unfinished'],
      ["<root>", "<!-- unfinished"],
    ])
      expect(await find(source(prefix + suffix), prefix.length, { xmlMode: true })).toBeNull();
  });

  it("preserves source offsets across chunk boundaries and never reads a whole prefix", async () => {
    const text = "<root data-value='" + "x".repeat(100000) + "'><child>" + "content".repeat(200000);
    let maxRead = 0;
    const input = {
      length: text.length,
      slice(start, end) {
        maxRead = Math.max(maxRead, end - start);
        if (end - start > 16384) throw new Error("unbounded tokenization read");
        return text.slice(start, end);
      },
    };
    expect(await find(input, text.length, { xmlMode: true })).toBe("child");
    expect(maxRead).toBeLessThanOrEqual(16384);
  });

  it("cancels during a long source walk and rejects token/stack limits before allocation", async () => {
    const controller = new AbortController();
    const text = "<root>" + "x".repeat(2_000_000);
    let reads = 0;
    const input = {
      length: text.length,
      slice(start, end) {
        if (++reads === 10) controller.abort();
        return text.slice(start, end);
      },
    };
    await expectAsync(
      find(input, text.length, { signal: controller.signal, xmlMode: true }),
    ).toBeRejected();
    expect(reads).toBeLessThan(20);
    const name = "a".repeat(4097);
    await expectAsync(
      find(source(`<${name}>`), name.length + 2, { xmlMode: true }),
    ).toBeRejectedWithError(/tag name exceeds/);
    const nested = "<a>".repeat(16385);
    await expectAsync(find(source(nested), nested.length, { xmlMode: true })).toBeRejectedWithError(
      /nesting exceeds/,
    );
  });

  it("works on a piece-tree source without a materialized document", async () => {
    const buffer = new TextBuffer({ text: "<root><child>body" });
    try {
      spyOn(buffer, "getText").and.throwError("whole document");
      expect(await find(buffer.getTextSnapshot(), buffer.getLength(), { xmlMode: true })).toBe(
        "child",
      );
    } finally {
      buffer.destroy();
    }
  });
});

describe("closing-tag request ownership", () => {
  let editor, view, closeTag;
  beforeEach(() => {
    jasmine.useRealClock();
    editor = new TextEditor();
    editor.setText("<root>content");
    editor.setCursorBufferPosition(editor.getBuffer().getEndPosition());
    view = { editor, destroyed: false };
    closeTag = require("../lib/bracket-matcher-view").prototype.closeTag;
  });
  afterEach(() => editor.destroy());

  it("inserts only after the immutable source and selection remain current", async () => {
    await closeTag.call(view);
    expect(editor.getText()).toBe("<root>content</root>");
    expect(view.closeTagController).toBeNull();
    editor.undo();
    expect(editor.getText()).toBe("<root>content");
  });

  it("discards a request after a text edit or selection change", async () => {
    let pending = closeTag.call(view);
    editor.setText("replacement");
    await pending;
    expect(editor.getText()).toBe("replacement");
    editor.setText("<root>content");
    editor.setCursorBufferPosition(editor.getBuffer().getEndPosition());
    pending = closeTag.call(view);
    editor.setCursorBufferPosition([0, 0]);
    await pending;
    expect(editor.getText()).toBe("<root>content");
    expect(view.closeTagController).toBeNull();
  });
});
