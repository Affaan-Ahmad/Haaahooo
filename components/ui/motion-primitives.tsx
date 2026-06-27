"use client";

import { motion, type HTMLMotionProps } from "motion/react";

/**
 * Reusable animation primitives built on Framer Motion (the `motion`
 * package). Kept tiny so they can wrap existing markup with minimal edits.
 *
 * Note: AnimatePresence (for exit animations) is imported directly in
 * page.tsx around the conditional that renders these.
 */

const SPRING = { type: "spring", stiffness: 420, damping: 30, mass: 0.7 } as const;

/** Popover / menu / overlay panel: clean spring in & out. */
export function MenuPop({ children, ...props }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={SPRING}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Centered overlay (e.g. call screen): gentle fade + lift. */
export function OverlayPop({ children, ...props }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 8 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** A message bubble row: gentle rise-in on mount. Cheap (opacity + y). */
export function MessageIn({ children, ...props }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 34, mass: 0.6 }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
