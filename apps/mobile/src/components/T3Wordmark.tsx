import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 80 / 88;
  return (
    <Svg
      accessibilityLabel="Cove Code"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="20 20 80 88"
    >
      <ThemedPath
        d="M93.7 34.3 A42 42 0 1 0 93.7 93.7 A8 8 0 0 0 82.38 82.38 A26 26 0 1 1 82.38 45.62 A8 8 0 0 0 93.7 34.3 Z M80 64 A12 12 0 1 1 56 64 A12 12 0 1 1 80 64 Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
