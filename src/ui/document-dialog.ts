import type { LeaveDecision } from "../markdown/session.js";

function dialog(message: string, choices: Array<[string, string]>): Promise<string> {
  return new Promise((resolve) => {
    const element = document.createElement("dialog");
    element.className = "document-dialog";
    element.setAttribute("aria-label", message);
    const text = document.createElement("p");
    text.textContent = message;
    element.appendChild(text);
    const buttons = document.createElement("div");
    for (const [value, label] of choices) {
      const button = document.createElement("button");
      button.textContent = label;
      // The value is what the stylesheet weights the choices by: losing work
      // must not be one indistinguishable button among three.
      button.value = value;
      if (value === "save" || value === "ok") button.autofocus = true;
      button.addEventListener("click", () => element.close(value));
      buttons.appendChild(button);
    }
    element.appendChild(buttons);
    element.addEventListener("close", () => {
      const answer = element.returnValue || "cancel";
      element.remove();
      resolve(answer);
    }, { once: true });
    document.body.appendChild(element);
    element.showModal();
  });
}

export async function confirmUnsavedDocument(name: string): Promise<LeaveDecision> {
  return await dialog(`是否保存“${name}”的修改？不保存会丢弃尚未保存的内容。`, [
    ["save", "保存"], ["discard", "不保存"], ["cancel", "取消"],
  ]) as LeaveDecision;
}

export async function showDocumentError(error: unknown): Promise<void> {
  await dialog(`文件操作失败：${error instanceof Error ? error.message : String(error)}`, [["ok", "确定"]]);
}
