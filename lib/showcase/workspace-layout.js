/**
 * Agent 工作区布局：主展区与右栏 Agent 联动
 * 关闭 AI 助手只收起 Agent；有目录命中时主展区保留（手机可先关侧栏再看展区）
 */
(function () {
  "use strict";

  function onAgentVisible(e) {
    var visible = !!(e && e.detail && e.detail.visible);
    document.body.classList.toggle("workspace-agent-open", visible);
    var hero = document.getElementById("site-hero");
    var sc = document.getElementById("site-content");
    var hasShowcase = document.body.classList.contains(
      "workspace-has-showcase"
    );

    if (visible) {
      if (hero) hero.classList.add("is-workspace-hidden");
      if (sc) {
        sc.hidden = false;
        sc.removeAttribute("hidden");
        sc.setAttribute("aria-hidden", "false");
      }
      if (
        window.SolutionShowcase &&
        typeof window.SolutionShowcase.ensureRoot === "function"
      ) {
        try {
          window.SolutionShowcase.ensureRoot();
        } catch (err) {}
      }
      return;
    }

    // 仅关闭 Agent
    if (hasShowcase) {
      // 保留主展区：手机上关掉全屏 Agent 后才能看到缩略图/详情
      if (hero) hero.classList.add("is-workspace-hidden");
      if (sc) {
        sc.hidden = false;
        sc.removeAttribute("hidden");
        sc.setAttribute("aria-hidden", "false");
      }
    } else {
      if (hero) hero.classList.remove("is-workspace-hidden");
      if (sc) {
        sc.hidden = true;
        sc.setAttribute("hidden", "");
        sc.setAttribute("aria-hidden", "true");
      }
    }
  }

  document.addEventListener("hzdv:agent-visible", onAgentVisible);
})();
