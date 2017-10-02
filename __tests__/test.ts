import helloWorld from "../src/index";

describe("index", () => {
    it('should export "Hello, World!', () => {
        expect(helloWorld).toEqual("Hello, World!");
    });
});
