/**
 * Agent 工作区布局：主展区与右栏 Agent 联动
 */
(function () {
  "use strict";

  function onAgentVisible(e) {
    var visible = !!(e && e.detail && e.detail.visible);
    document.body.classList.toggle("workspace-agent-open", visible);
    var hero = document.getElementById("site-hero");
    var sc = document.getElementById("site-content");
    if (visible) {
      if (hero) hero.classList.add("is-workspace-hidden");
      if (sc) {
        sc.hidden = false;
        sc.removeAttribute("hidden");
        sc.setAttribute("aria-hidden", "false");
      }
      // 打开助手时挂载主展区壳子，避免左侧一直空白
      if (
        window.SolutionShowcase &&
        typeof window.SolutionShowcase.ensureRoot === "function"
      ) {
        try {
          window.SolutionShowcase.ensureRoot();
        } catch (err) {}
      }
    } else if (hero) {
      var hasShowcase = document.body.classList.contains(
        "workspace-has-showcase"
      );
      if (!hasShowcase) hero.classList.remove("is-workspace-hidden");
    }
  }

  document.addEventListener("hzdv:agent-visible", onAgentVisible);
})();
