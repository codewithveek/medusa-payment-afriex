import { type RouteConfig, index, route } from "@react-router/dev/routes"

export default [
  index("routes/home.tsx"),
  route("checkout", "routes/checkout.tsx"),
  route("order/:orderId", "routes/order.tsx"),
  route("checkout/afriex/return/:orderId", "routes/afriex-return.tsx"),
] satisfies RouteConfig
