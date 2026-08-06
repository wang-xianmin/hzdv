/**
 * Agent 工作区布局：主展区与右栏 Agent 联动
 */
(function () {
  "use strict";

  function restoreHome() {
    document.body.classList.remove("workspace-has-showcase");
    var hero = document.getElementById("site-hero");
    var sc = document.getElementById("site-content");
    if (hero) hero.classList.remove("is-workspace-hidden");
    if (sc) {
      sc.hidden = true;
      sc.setAttribute("hidden", "");
      sc.setAttribute("aria-hidden", "true");
    }
    if (
      window.SolutionShowcase &&
      typeof window.SolutionShowcase.clear === "function"
    ) {
      try {
        window.SolutionShowcase.clear();
      } catch (err) {}
    }
  }

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
    } else {
      // 关闭 AI 助手：主展区与 Agent 一并收起，恢复首页背景与菜单态
      restoreHome();
    }
  }

  document.addEventListener("hzdv:agent-visible", onAgentVisible);
})();
