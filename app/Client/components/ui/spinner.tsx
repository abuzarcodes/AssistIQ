import { Loader2 } from 'lucide-react';

type SpinnerSize = 'sm' | 'md' | 'lg';

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
};

export function Spinner({ size = 'md', className = '' }: { size?: SpinnerSize; className?: string }) {
  return (
    <Loader2
      className={`animate-spin text-muted-foreground ${sizeClasses[size]} ${className}`}
    />
  );
}
