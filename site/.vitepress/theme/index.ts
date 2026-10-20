import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import WinterBackdrop from "./WinterBackdrop.vue";
import "./custom.css";

// the home page stands on a winter range: drawn here, no image to load
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "layout-top": () => h(WinterBackdrop) }),
};
