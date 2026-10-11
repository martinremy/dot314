import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import protectPaths from "./index.ts";

type ToolCallResult = { block: true; reason?: string } | undefined;
type ToolCallHandler = (
    event: { toolName: string; input: Record<string, unknown> },
    context: {
        hasUI: boolean;
        ui: {
            notify: (message: string, level: string) => void;
            confirm: (title: string, message: string) => Promise<boolean>;
        };
    },
) => Promise<ToolCallResult>;

const DEPENDENCY_PATH = "/tmp/project/node_modules/package";

type ToolInput = { path: string } | { command: string };

function createToolRunner(): (toolName: string, input: ToolInput) => Promise<ToolCallResult> {
    const handlers: ToolCallHandler[] = [];
    const pi = {
        on(eventName: string, handler: ToolCallHandler) {
            if (eventName === "tool_call") handlers.push(handler);
        },
    } as unknown as ExtensionAPI;

    protectPaths(pi);

    return async (toolName, input) => {
        const event = { toolName, input };
        const context = {
            hasUI: false,
            ui: {
                notify: () => undefined,
                confirm: async () => true,
            },
        };

        for (const handler of handlers) {
            const result = await handler(event, context);
            if (result?.block) return result;
        }

        return undefined;
    };
}

function createBashRunner(): (command: string) => Promise<ToolCallResult> {
    const runTool = createToolRunner();
    return (command) => runTool("bash", { command });
}

test("read tools can inspect node_modules but write tools cannot", async () => {
    const runTool = createToolRunner();

    assert.equal(await runTool("read", { path: `${DEPENDENCY_PATH}/index.js` }), undefined);
    assert.equal((await runTool("edit", { path: `${DEPENDENCY_PATH}/index.js` }))?.block, true);
});

test("read-only Bash commands can reference node_modules anywhere", async () => {
    const runBash = createBashRunner();
    const commands = [
        "ls -R | grep -v node_modules | head -40; rg -n -i orca --glob '!node_modules' .",
        'find . -maxdepth 3 -iname "*guard*" -not -path "*/node_modules/*"',
        "ls /tmp/project/node_modules/package/index.js",
    ];

    for (const command of commands) {
        assert.equal(await runBash(command), undefined, command);
    }
});

test("non-read-only node_modules commands remain blocked", async () => {
    const runBash = createBashRunner();
    const commands = [
        `cp patch.js ${DEPENDENCY_PATH}/index.js`,
        `rg --pre ${DEPENDENCY_PATH}/bin/run pattern .`,
        `rg --pre=${DEPENDENCY_PATH}/bin/run pattern .`,
    ];

    for (const command of commands) {
        assert.equal((await runBash(command))?.block, true, command);
    }
});

test("output redirection into node_modules remains blocked", async () => {
    const runBash = createBashRunner();
    const result = await runBash(`echo changed > ${DEPENDENCY_PATH}/generated.js`);

    assert.equal(result?.block, true);
});

test("mutating find actions in node_modules remain blocked", async () => {
    const runBash = createBashRunner();
    const result = await runBash(`find ${DEPENDENCY_PATH} -delete`);

    assert.equal(result?.block, true);
});
