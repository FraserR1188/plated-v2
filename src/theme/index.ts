export const Colors = {
  bg:        '#0D0D0D',
  surface:   '#1A1A1A',
  surface2:  '#252525',
  border:    '#2E2E2E',
  text:      '#F2F2F7',
  textMuted: '#888888',
  textDim:   '#444444',
  green:     '#00D97E',
  greenDim:  '#012916',
  blue:      '#4A9EFF',
  amber:     '#FFB340',
  coral:     '#FF6B6B',
  purple:    '#BF7FFF',
  teal:      '#2DD4BF',
  pink:      '#FF6EB4',
  danger:    '#FF4444',
};

// One colour per macro for bars/labels
export const MacroColor: Record<string, string> = {
  protein: Colors.blue,
  carbs:   Colors.amber,
  fat:     Colors.coral,
  salt:    Colors.purple,
  fibre:   Colors.teal,
  sugar:   Colors.pink,
};

export const Spacing = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48,
};

export const Radius = {
  sm: 8, md: 12, lg: 20, xl: 28, full: 999,
};

export const Typography = {
  xs: 11, sm: 13, base: 15, md: 17, lg: 20, xl: 24, xxl: 32, hero: 48,
  regular: '400' as const,
  medium:  '500' as const,
  semibold:'600' as const,
  bold:    '700' as const,
};
