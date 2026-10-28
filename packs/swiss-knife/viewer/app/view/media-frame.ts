export interface DrawnRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

const NO_RECT: DrawnRect = { left: 0, top: 0, width: 0, height: 0 };

export function drawnRect(videoWidth: number, videoHeight: number, boxWidth: number, boxHeight: number): DrawnRect {
	const sizes = [videoWidth, videoHeight, boxWidth, boxHeight];
	if (!sizes.every(size => Number.isFinite(size) && size > 0)) return NO_RECT;
	const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
	const width = videoWidth * scale;
	const height = videoHeight * scale;
	return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}
