// Guards React 17 against external DOM mutation — Chrome page-translation and
// DOM-rewriting browser extensions wrap or move text nodes React owns; React's
// commit phase then calls removeChild/insertBefore against a stale parent and
// the WHOLE tree crashes into the error boundary:
//   NotFoundError: Failed to execute 'removeChild' on 'Node':
//   The node to be removed is not a child of this node.
// Observed on production employee complaint-details pages when the browser
// translated the page. This is the standard mitigation for react#11538 until
// the app is on React 18, which tolerates the mismatch natively.
//
// Contract: when the node genuinely belongs to the parent, behaviour is
// identical to the native methods. Only the crashing case — a parent mismatch
// caused by an external mutator — degrades to a no-op with a rate-limited
// warning, so React can finish reconciling the rest of the tree.

let warnings = 0;
const warnOnce = (op) => {
  if (warnings >= 5) return;
  warnings += 1;
  // Deliberate console.warn: the only signal that an external tool
  // (translation/extension) is rewriting the app's DOM on this session.
  console.warn(
    `[dom-guard] ${op} skipped — node is not a child of the expected parent. ` +
      "An external tool (e.g. browser page translation) has modified the page; the app continues."
  );
};

if (typeof Node === "function" && Node.prototype) {
  const nativeRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function removeChildGuarded(child) {
    if (child && child.parentNode !== this) {
      warnOnce("removeChild");
      return child;
    }
    return nativeRemoveChild.apply(this, arguments);
  };

  const nativeInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function insertBeforeGuarded(newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      warnOnce("insertBefore");
      return newNode;
    }
    return nativeInsertBefore.apply(this, arguments);
  };
}
