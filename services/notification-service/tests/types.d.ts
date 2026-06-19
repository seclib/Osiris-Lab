/// <reference types="jest" />

declare module 'socket.io' {
  export const Server: any;
  export const Socket: any;
}

declare module 'firebase-admin' {
  export const messaging: any;
}