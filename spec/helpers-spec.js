const { adviseBefore } = require("../lib/helpers");

describe("adviseBefore", () => {
  it("can remove an older advice without disrupting a newer one", () => {
    const original = jasmine.createSpy("original").and.returnValue("result");
    const older = jasmine.createSpy("older");
    const newer = jasmine.createSpy("newer");
    const object = { method: original };
    const olderDisposable = adviseBefore(object, "method", older);
    const newerDisposable = adviseBefore(object, "method", newer);

    olderDisposable.dispose();
    expect(object.method()).toBe("result");
    expect(older).not.toHaveBeenCalled();
    expect(newer.calls.count()).toBe(1);
    expect(original.calls.count()).toBe(1);

    newerDisposable.dispose();
    expect(object.method).toBe(original);
  });
});
