function selectionSource(selection) {
  const buffer = selection.editor.getBuffer();
  const range = selection.getBufferRange();
  return buffer
    .getTextSnapshot()
    .subtext(
      buffer.characterIndexForPosition(range.start),
      buffer.characterIndexForPosition(range.end),
    );
}

function bracketSelectionText(selection, pairs) {
  const source = selectionSource(selection);
  if (!Object.keys(pairs).some((key) => key.length === source.length)) return "";
  return source.slice(0, source.length);
}

function wrappedSource(source, opening, closing) {
  return source.replace(source.length, source.length, closing).replace(0, 0, opening);
}

function precedingContext(editor, position) {
  const buffer = editor.getBuffer();
  const source = buffer.getTextSnapshot();
  const end = buffer.characterIndexForPosition(position);
  const start = end - position.column;
  const previousCharacter = source.slice(Math.max(start, end - 1), end);
  let at = previousCharacter === "\\" ? end : end - 1;
  const runEnd = at;
  while (at > start) {
    const from = Math.max(start, at - 4096);
    const chunk = source.slice(from, at);
    const run = chunk.match(/\\*$/)[0].length;
    at -= run;
    if (run !== chunk.length) break;
  }
  const count = Math.max(0, runEnd - at);
  return {
    previousCharacter,
    escaped: previousCharacter === "\\" && count % 2 === 1,
    escapeSequence: count > 0 && (previousCharacter === "\\" ? count % 2 === 0 : count % 2 === 1),
  };
}

module.exports = { selectionSource, bracketSelectionText, wrappedSource, precedingContext };
