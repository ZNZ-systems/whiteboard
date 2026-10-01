import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Context, Script, createContext } from "node:vm";

import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { makeLibavoidCspSafe } from "./libavoid-csp";

const require = createRequire(import.meta.url);

const distributionPath = path.join(
  path.dirname(require.resolve("libavoid-js")),
  "index.js",
);

const distribution = readFileSync(distributionPath, "utf8");

const transformed = makeLibavoidCspSafe(distribution);

function evaluateGenerator(
  source: string,
  start: string,
  end: string,
  globals: Context,
) {
  const code = source.slice(
    source.indexOf(start),
    source.indexOf(end, source.indexOf(start)),
  );

  return new Script(
    start.startsWith("function")
      ? `${code}; Oe`
      : `({${code}})._emval_get_method_caller`,
  ).runInContext(
    createContext(globals, {
      codeGeneration: { strings: false, wasm: false },
    }),
  );
}

function embindGenerator() {
  return evaluateGenerator(transformed, "function Oe(", "for(var xe=", {
    m: Error,
    d: (condition: boolean, message: string) => {
      if (!condition) throw new Error(message);
    },
    Qt: (message: string) => {
      throw new Error(message);
    },
    $t: (types: Array<{ s?: unknown } | null>) =>
      types.slice(1).some((type) => type !== null && type.s === undefined),
    _e: (name: string, fn: Function) =>
      Object.defineProperty(fn, "name", { value: name }),
    cr: (
      actual: number,
      min: number,
      max: number,
      name: string,
      fail: Function,
    ) => {
      if (actual < min || actual > max)
        fail(`${name}: invalid argument count ${actual}`);
    },
    ke: (destructors: any[]) => {
      while (destructors.length) {
        const value = destructors.pop();
        destructors.pop()(value);
      }
    },
  });
}

describe("libavoid extension CSP transform", () => {
  it("refuses changed distributions instead of shipping unreviewed bindings", () => {
    for (const source of [
      distribution.replace("function Oe(", "function changed("),
      distribution.replace("_emval_get_method_caller:", "_emval_changed:"),
      distribution.replace(".optional", ".differentOptionalFlag"),
      `${distribution}\nnew Function('return 1')();`,
    ]) {
      expect(() => makeLibavoidCspSafe(source)).toThrow(
        "Unsupported libavoid-js",
      );
    }
  });

  it.each([false, true])(
    "converts optional arguments and this, then cleans up before the return (destructor stack: %s)",
    (stack) => {
      const events: unknown[] = [];
      const receiver = { pointer: 10 };

      const converter = <T>(
        name: string,
        convert: (value: T) => number,
        optional = false,
      ) => {
        const destructor = (value: number) =>
          events.push(["destroy", name, value]);

        return {
          name,
          optional,
          s: stack ? undefined : destructor,
          toWireType(destructors: any[] | null, value: T) {
            const result = convert(value);
            events.push(["convert", name, value]);

            if (stack) destructors!.push(destructor, result);
            else expect(destructors).toBeNull();

            return result;
          },
        };
      };

      const types = [
        {
          name: "int",
          fromWireType(value: number) {
            events.push(["return", value]);

            return value * 2;
          },
        },
        converter("this", (value: typeof receiver) => value.pointer),
        converter("required", (value: number) => value * 10),
        converter(
          "optional",
          (value: number | undefined) => (value ?? 7) * 10,
          true,
        ),
      ];

      const invoker = vi.fn<(...values: number[]) => number>((...values) => {
        events.push(["invoke", ...values]);

        return 110;
      });

      const wrapper = embindGenerator()(
        "Shape.method",
        types,
        {},
        invoker,
        99,
        false,
      );

      expect(wrapper.name).toBe("Shape.method");
      expect(wrapper.length).toBe(2);
      expect(() => wrapper.call(receiver)).toThrow("invalid argument count");
      expect(() => wrapper.call(receiver, 1, 2, 3)).toThrow(
        "invalid argument count",
      );
      expect(events).toEqual([]);
      expect(wrapper.call(receiver, 3)).toBe(220);
      expect(invoker).toHaveBeenCalledWith(99, 10, 30, 70);

      const cleanup = [
        ["destroy", "this", 10],
        ["destroy", "required", 30],
        ["destroy", "optional", 70],
      ];

      expect(events).toEqual([
        ["convert", "this", receiver],
        ["convert", "required", 3],
        ["convert", "optional", undefined],
        ["invoke", 99, 10, 30, 70],
        ...(stack ? cleanup.reverse() : cleanup),
        ["return", 110],
      ]);
    },
  );

  it("preserves void returns, null destructors, no-this functions and invoker errors", () => {
    const fromWireType = vi.fn<(value: number) => number>();
    const destructor = vi.fn<(value: number) => void>();
    const invoke = vi.fn<(...values: number[]) => number>(() => 12);

    const types = [
      { name: "void", fromWireType },
      null,
      { toWireType: (_destructors: null, value: number) => value, s: null },
    ];

    const generate = embindGenerator();
    const wrapper = generate("freeFunction", types, null, invoke, 77, false);
    expect(wrapper(5)).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(77, 5);
    expect(fromWireType).not.toHaveBeenCalled();

    const failure = new Error("invoker failed");

    const throwing = generate(
      "throwingFunction",
      [types[0], null, { ...types[2], s: destructor }],
      null,
      () => {
        throw failure;
      },
      77,
      false,
    );

    expect(() => throwing(5)).toThrow(failure);
    expect(destructor).not.toHaveBeenCalled();
    expect(() =>
      generate("asyncFunction", types, null, invoke, 77, true),
    ).toThrow("JSPI");
  });

  it.each([0, 1])(
    "reads emval arguments and converts method/constructor returns (mode %s)",
    (mode) => {
      class Constructed {
        sum: number;
        constructor(first: number, second: number) {
          this.sum = first + second;
        }
      }

      const receiver = { base: 10 };
      const readFirst = vi.fn<(pointer: number) => number>(() => 7);
      const readSecond = vi.fn<(pointer: number) => number>(() => 9);
      const returnType = { name: "result", W: false };

      const returnValue = vi.fn<
        (
          type: typeof returnType,
          destructorsRef: number,
          value: number | Constructed,
        ) => {
          destructorsRef: number;
          value: number | Constructed;
        }
      >((_type, destructorsRef, value) => ({ destructorsRef, value }));

      const register = vi.fn<(fn: Function) => Function>((fn) => fn);

      const generate = evaluateGenerator(
        transformed,
        "_emval_get_method_caller:",
        "_emval_incref:",
        {
          Tr: () => [
            returnType,
            { name: "first", o: 8, readValueFromPointer: readFirst },
            { name: "second", o: 4, readValueFromPointer: readSecond },
          ],
          Er: returnValue,
          _r: register,
          _e: (name: string, fn: Function) =>
            Object.defineProperty(fn, "name", { value: name }),
        },
      );

      const caller = generate(3, 80, mode);

      const callable =
        mode === 1
          ? Constructed
          : function (this: typeof receiver, first: number, second: number) {
              expect(this).toBe(receiver);

              return this.base + first + second;
            };

      const result = caller(receiver, callable, 60, 100);
      expect(caller.length).toBe(4);
      expect(caller.name).toBe("methodCaller<(first, second) => result>");
      expect(register).toHaveBeenCalledWith(caller);
      expect(readFirst).toHaveBeenCalledWith(100);
      expect(readSecond).toHaveBeenCalledWith(108);
      expect(result.destructorsRef).toBe(60);

      expect(result.value).toStrictEqual(
        mode === 1 ? new Constructed(7, 9) : 26,
      );
      expect(returnValue).toHaveBeenCalledWith(returnType, 60, result.value);
    },
  );

  it("skips emval return conversion for void methods and propagates call failures", () => {
    const returnValue = vi.fn<() => void>();
    const method = vi.fn<() => number>(() => 42);

    const generate = evaluateGenerator(
      transformed,
      "_emval_get_method_caller:",
      "_emval_incref:",
      {
        Tr: () => [{ name: "void", W: true }],
        Er: returnValue,
        _r: (fn: Function) => fn,
        _e: (_name: string, fn: Function) => fn,
      },
    );

    const caller = generate(1, 0, 0);

    expect(caller(null, method, 0, 0)).toBeUndefined();
    expect(method).toHaveBeenCalledExactlyOnceWith();
    expect(returnValue).not.toHaveBeenCalled();

    const failure = new Error("method failed");
    method.mockImplementation(() => {
      throw failure;
    });

    expect(() => caller(null, method, 0, 0)).toThrow(failure);
    expect(returnValue).not.toHaveBeenCalled();
  });

  it("initializes the real browser WASM module and routes around an obstacle without dynamic compilation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "libavoid-csp-"));

    try {
      const bundled = await build({
        stdin: {
          contents: `
            import assert from "node:assert/strict";
            import { readFile } from "node:fs/promises";
            import { init, routeEdges } from "@mr_mint/elkjs-libavoid";
            import { AvoidLib } from "libavoid-js";

            const wasm = await readFile(${JSON.stringify(path.join(path.dirname(distributionPath), "libavoid.wasm"))});
            const response = new Response(wasm, { headers: { "Content-Type": "application/wasm" } });
            globalThis.window = {};
            globalThis.fetch = async () => response.clone();
            let dynamicCompilationAttempts = 0;
            const forbidden = function() {
              dynamicCompilationAttempts++;
              throw new Error("Dynamic JavaScript compilation forbidden");
            };
            globalThis.Function = forbidden;
            globalThis.eval = forbidden;

            await init("https://extension.test/libavoid.wasm");
            const Avoid = AvoidLib.getInstance();
            const point = new Avoid.Point(12, 34);
            assert.equal(point.x, 12);
            assert.equal(point.y, 34);
            point.x = 56;
            assert.equal(point.x, 56);
            point.delete();
            assert.throws(() => point.x, /deleted/);
            const routes = await routeEdges({
              id: "root",
              children: [
                { id: "source", x: 0, y: 80, width: 40, height: 40,
                  ports: [{ id: "out", x: 40, y: 20, properties: { "port.side": "EAST" } }] },
                { id: "obstacle", x: 130, y: 40, width: 80, height: 120 },
                { id: "target", x: 300, y: 80, width: 40, height: 40,
                  ports: [{ id: "in", x: 0, y: 20, properties: { "port.side": "WEST" } }] }
              ],
              edges: [{ id: "connection", sources: ["out"], targets: ["in"] }]
            });
            assert.equal(routes.size, 1);
            const route = routes.get("connection");
            assert.deepEqual(route.sourcePoint, { x: 40, y: 100 });
            assert.deepEqual(route.targetPoint, { x: 300, y: 100 });
            assert.ok(route.bendPoints.length >= 2);
            const points = [route.sourcePoint, ...route.bendPoints, route.targetPoint];
            for (let i = 1; i < points.length; i++) {
              const a = points[i - 1], b = points[i];
              assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
              assert.ok(a.x === b.x || a.y === b.y);
              const crossesInterior = a.x === b.x
                ? a.x > 130 && a.x < 210 && Math.max(a.y, b.y) > 40 && Math.min(a.y, b.y) < 160
                : a.y > 40 && a.y < 160 && Math.max(a.x, b.x) > 130 && Math.min(a.x, b.x) < 210;
              assert.equal(crossesInterior, false);
            }
            assert.equal(dynamicCompilationAttempts, 0);
            console.log("routed around obstacle without dynamic compilation");
          `,
          resolveDir: path.dirname(distributionPath),
          sourcefile: "libavoid-csp-routing.mjs",
        },
        bundle: true,
        format: "esm",
        platform: "node",
        write: false,
        plugins: [
          {
            name: "test-browser-libavoid",
            setup(builder) {
              builder.onResolve({ filter: /^libavoid-js$/ }, () => ({
                path: distributionPath,
              }));
              builder.onLoad(
                { filter: /libavoid-js\/dist\/index\.js$/ },
                () => ({
                  contents: transformed,
                  loader: "js",
                }),
              );
            },
          },
        ],
      });

      const entry = path.join(directory, "routing.mjs");
      await writeFile(entry, bundled.outputFiles[0].text);

      const { stdout } = await promisify(execFile)(process.execPath, [entry], {
        timeout: 10_000,
      });

      expect(stdout).toContain(
        "routed around obstacle without dynamic compilation",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
