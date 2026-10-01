import { createBroker, stateSchema } from "./broker";
import { routeLayout } from "./layout-worker";

const ready = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});

const broker = createBroker({
  extensionId: chrome.runtime.id,
  load: async () => {
    await ready;
    const stored = await chrome.storage.local.get("whiteboard");
    const parsed = stateSchema.safeParse(stored.whiteboard);

    return parsed.success ? parsed.data : { connection: null, bindings: [] };
  },
  save: async (state) => {
    await ready;
    await chrome.storage.local.set({ whiteboard: stateSchema.parse(state) });
  },
  tabUrl: async (id) => (await chrome.tabs.get(id)).url,
  openOptions: () => chrome.runtime.openOptionsPage(),
  request: fetch,
  routeLayout,
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void ready
    .then(() => broker(message, sender))
    .then((response) => {
      if (response !== undefined) respond(response);
    })
    .catch(() => undefined);

  return true;
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  void chrome.tabs
    .sendMessage(tabId, { type: "review:route-changed" })
    .catch(() => undefined);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.whiteboard) return;
  void chrome.tabs.query({ url: "https://linear.app/*" }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined)
        void chrome.tabs
          .sendMessage(tab.id, { type: "review:binding-changed" })
          .catch(() => undefined);
    }
  });
});
