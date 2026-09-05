const { Disposable } = require("lumine");

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const adviceState = Symbol("adviceState");

function adviseBefore(object, method, fn) {
  let state = object[method]?.[adviceState];
  if (!state || state.object !== object || state.method !== method) {
    const ownDescriptor = Object.getOwnPropertyDescriptor(object, method);
    const original = object[method];
    const entries = [];
    const wrapper = function (...args) {
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index].fn.apply(this, args) === false) return;
      }
      return original.apply(this, args);
    };
    state = { object, method, ownDescriptor, entries, wrapper };
    Object.defineProperty(wrapper, adviceState, { value: state });
    object[method] = wrapper;
  }

  const entry = { fn };
  state.entries.push(entry);
  return new Disposable(() => {
    const index = state.entries.indexOf(entry);
    if (index !== -1) state.entries.splice(index, 1);
    if (state.entries.length > 0 || object[method] !== state.wrapper) return;

    if (state.ownDescriptor) {
      Object.defineProperty(object, method, state.ownDescriptor);
    } else {
      delete object[method];
    }
  });
}

module.exports = { escapeRegExp, adviseBefore };
