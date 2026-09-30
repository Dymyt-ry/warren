// Mark + wordmark. The mark swaps to its dark-mode colours via CSS.
export function Logo() {
  return (
    <span className="logo">
      <img className="light" src="/warren-mark.svg" alt="" />
      <img className="dark" src="/warren-mark-dark.svg" alt="" />
      warren
    </span>
  );
}
