import { APPGROWTH_HEAD } from "./shims/appgrowth.js";

// Packaging profiles. Runtime behavior lives in playable/kit/networks.js.
// Google App campaigns and TikTok SDK references checked 2026-09-25:
// https://support.google.com/google-ads/answer/9981650?hl=en
// https://ads.tiktok.com/resources/help/article/playable-ads?lang=en
// Other profiles retain inherited packaging rules and require network-device QA.
// container: "zip" or a single HTML; maxMb is enforced on final package bytes (MiB).
// beforeGame: SDK script inserted before the game; head: tags inserted in the head.
// assetFiles: externalize declared assets inside the ZIP; inline:false: separate game JS.
// label: display name for editors. storeUrl: whether the CTA forwards options.link to the network
//   "always" — the URL is passed to MRAID / window.open
//   "maybe"  — MRAID is tried with the URL first, otherwise the network SDK decides the store
//   "never"  — the network SDK opens the store configured in the campaign; options.link is ignored
// Keep the keys in sync with playable/kit/networks.js (enforced by tests/export.test.js).

export const NETWORK_PROFILE_VERSION = 1;

const MINTEGRAL_HEAD = `<script>window.__PL_HOST_STARTED__=false;function gameStart(){window.__PL_HOST_STARTED__=true;window.dispatchEvent(new Event("pl:host-start"))}function gameClose(){window.__PL_HOST_STARTED__=false;window.dispatchEvent(new Event("pl:host-close"))}</script>`;

// Runtime behavior belongs in kit/networks.js; never rewrite bundled JavaScript.

export const EXPORT_NETWORKS = {
  default: { label: "Default (HTML)", container: "html", storeUrl: "always", maxMb: 5 },
  applovin: { label: "AppLovin", container: "html", storeUrl: "never", maxMb: 5 },
  ironsource: { label: "ironSource", container: "html", storeUrl: "always", maxMb: 5 },
  smadex: { label: "Smadex", container: "html", storeUrl: "never", maxMb: 5 },
  unity: {
    label: "Unity Ads",
    container: "html",
    storeUrl: "always",
    head: '<script src="mraid.js"></script>',
    maxMb: 5
  },
  mintegral: {
    label: "Mintegral",
    container: "html",
    storeUrl: "never",
    head: MINTEGRAL_HEAD,
    htmlName: "mintegral.html",
    maxMb: 5
  },
  appgrowth: { label: "AppGrowth", container: "html", storeUrl: "never", head: APPGROWTH_HEAD, maxMb: 5 },
  moloco: { label: "Moloco", container: "html", storeUrl: "maybe", maxMb: 5 },
  facebook: {
    label: "Meta (Facebook)",
    container: "zip",
    storeUrl: "maybe",
    inline: false,
    script: "game.js",
    maxMb: 2
  },
  google: {
    label: "Google Ads",
    container: "zip",
    storeUrl: "never",
    maxFiles: 512,
    inline: false,
    script: "main.js",
    head: '<meta name="ad.orientation" content="portrait,landscape">\n<script src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>',
    maxMb: 5
  },
  liftoff: {
    label: "Liftoff",
    container: "zip",
    storeUrl: "always",
    inline: false,
    script: "main.js",
    maxMb: 5
  },
  tiktok: {
    label: "TikTok",
    container: "zip",
    storeUrl: "never",
    beforeGame:
      '<script src="https://sf16-muse-va.ibytedtos.com/obj/union-fe-nc-i18n/playable/sdk/playable-sdk.js"></script>',
    assetFiles: true,
    extraFiles: { "config.json": '{"playable_orientation":0}' },
    maxMb: 5
  }
};

export const EXPORT_NETWORK_NAMES = Object.keys(EXPORT_NETWORKS);
