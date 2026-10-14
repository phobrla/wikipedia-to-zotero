/* global Zotero, Services, WikipediaZoteroCore, WikipediaZoteroPlugin */
var WikipediaZoteroCore;
var WikipediaZoteroPlugin;

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "core.js");
  Services.scriptloader.loadSubScript(rootURI + "plugin.js");
  WikipediaZoteroPlugin.init(WikipediaZoteroCore);
  for (const window of Zotero.getMainWindows()) {
    WikipediaZoteroPlugin.addToWindow(window);
  }
}

function onMainWindowLoad({ window }) {
  WikipediaZoteroPlugin?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  WikipediaZoteroPlugin?.removeFromWindow(window);
}

function shutdown() {
  WikipediaZoteroPlugin?.shutdown();
  WikipediaZoteroPlugin = undefined;
  WikipediaZoteroCore = undefined;
}

function install() {}
function uninstall() {}
