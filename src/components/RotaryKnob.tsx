/**
 * RotaryKnob — Circular rotary control for angles and rates
 * Features smooth mouse drag interaction with visual rotation indicator
 */

import { useRef, useState, useEffect } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  unit?: string;
  className?: string;
  size?: 'small' | 'medium' | 'large';
}

export function RotaryKnob({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  unit = '',
  className = '',
  size = 'medium',
}: Props) {
  const knobRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [displayValue, setDisplayValue] = useState(value);

  const sizeClasses = {
    small: 'w-20 h-20',
    medium: 'w-24 h-24',
    large: 'w-32 h-32',
  };

  const textSizeClasses = {
    small: 'text-xs',
    medium: 'text-sm',
    large: 'text-base',
  };

  // Handle mouse move for dragging
  useEffect(() => {
    if (!isDragging || !knobRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      const knob = knobRef.current;
      if (!knob) return;

      const rect = knob.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Calculate angle from center
      const dx = e.clientX - centerX;
      const dy = e.clientY - centerY;
      let angle = Math.atan2(dy, dx) * (180 / Math.PI);

      // Normalize angle to 0-360
      angle = (angle + 90 + 360) % 360;

      // Map angle to value
      const newValue = min + (angle / 360) * (max - min);
      const steppedValue = Math.round(newValue / step) * step;
      const clampedValue = Math.max(min, Math.min(max, steppedValue));

      onChange(clampedValue);
      setDisplayValue(clampedValue);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, min, max, step, onChange]);

  // Convert value to rotation angle (0-360 degrees, mapped from min-max range)
  const rotation = ((value - min) / (max - min)) * 360;

  useEffect(() => {
    const knob = knobRef.current;
    if (!knob) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      setDisplayValue((prev) => {
        const newValue = Math.max(min, Math.min(max, prev + direction * step));
        onChange(newValue);
        return newValue;
      });
    };

    knob.addEventListener('wheel', handleWheel, { passive: false });
    return () => knob.removeEventListener('wheel', handleWheel);
  }, [min, max, step, onChange]);

  const handleMouseDown = () => {
    setIsDragging(true);
  };

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <div
        ref={knobRef}
        className={`${sizeClasses[size]} relative cursor-grab active:cursor-grabbing select-none`}
        onMouseDown={handleMouseDown}
      >
        {/* Outer glow ring */}
        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-500/20 via-transparent to-amber-600/20 shadow-[0_0_30px_rgba(245,158,11,0.3),inset_0_0_30px_rgba(245,158,11,0.1)]" />

        {/* Main knob body with 3D effect */}
        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-zinc-900 via-zinc-950 to-black shadow-[0_4px_12px_rgba(0,0,0,0.8),inset_0_1px_3px_rgba(255,255,255,0.1)]" />

        {/* Inner rim highlight */}
        <div className="absolute inset-1 rounded-full shadow-[inset_0_1px_0_rgba(255,215,0,0.3)]" />

        {/* Rotation indicator - a small amber pointer */}
        <div
          className="absolute top-1 left-1/2 w-1 h-2 -translate-x-1/2 rounded-full bg-gradient-to-b from-amber-300 to-amber-500 shadow-[0_0_8px_rgba(255,215,0,0.6)]"
          style={{
            transform: `translateX(-50%) rotate(${rotation}deg)`,
            transformOrigin: '0 12px',
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
        />

        {/* Center circle with value display */}
        <div className="absolute inset-2 rounded-full bg-gradient-to-br from-zinc-900 via-zinc-950 to-black shadow-[inset_0_2px_4px_rgba(0,0,0,0.8),inset_0_-1px_2px_rgba(255,215,0,0.1)]" />

        {/* Value display */}
        <div className={`absolute inset-0 flex items-center justify-center flex-col ${textSizeClasses[size]}`}>
          <div className="font-mono font-bold text-amber-300 tabular-nums">
            {Math.round(displayValue)}
          </div>
        </div>
      </div>

      {/* Label */}
      <div className="text-center">
        <div className="text-xs font-mono text-amber-400/80 whitespace-nowrap">
          {label}
        </div>
        {unit && (
          <div className="text-[10px] font-mono text-amber-300/60">
            {unit}
          </div>
        )}
      </div>
    </div>
  );
}
