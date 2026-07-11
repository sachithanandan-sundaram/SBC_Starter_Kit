import { GridVideoPlayer } from "./GridVideoPlayer";

interface GridCellProps {
  cellNumber: 1 | 2 | 3 | 4;
  src: string | null;
  title?: string;
}

export function GridCell({ cellNumber, src, title }: GridCellProps) {
  const label = title || (cellNumber === 1 ? "Raw Stream" : `Model ${cellNumber - 1}`);

  return (
    <div className="h-full w-full overflow-hidden rounded-none border-b border-r border-border/60 bg-black last:border-b-0 last:border-r-0">
      <GridVideoPlayer src={src} title={label} />
    </div>
  );
}

