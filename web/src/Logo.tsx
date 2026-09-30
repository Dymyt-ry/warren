// Mark + wordmark. The mark swaps to its dark-mode colours through <picture>, independent of any CSS layer.
// Pages pinned to light (the landing) pass theme="light".
export function Logo({ theme }: { theme?: "light" }) {
  return (
    <span className="logo">
      <picture>
        {theme !== "light" && <source srcSet="/warren-mark-dark.svg" media="(prefers-color-scheme: dark)" />}
        <img src="/warren-mark.svg" alt="" width={26} height={26} />
      </picture>
      warren
    </span>
  );
}
