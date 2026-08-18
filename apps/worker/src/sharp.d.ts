declare module "sharp" {
  const sharp: (
    input?:
      | Uint8Array
      | Buffer
      | {
          create: {
            width: number;
            height: number;
            channels: 3 | 4;
            background: string;
          };
        },
    options?: unknown,
  ) => any;
  export default sharp;
}
