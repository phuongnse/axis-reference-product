# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS frontend
RUN npm install --global npm@11.16.0 --ignore-scripts
WORKDIR /src
COPY package.json package-lock.json .npmrc openapi-ts.config.ts openapi.json index.html manifest.json tsconfig.json vite.config.ts ./
COPY src/ ./src/
RUN npm ci && npm run generate:api && npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:72dd743782f2ae7e5476fd64f6a460045e3998dc862218b80e6944cba79a01b0 AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY server/Axis.ReferenceProduct.Bff/Axis.ReferenceProduct.Bff.csproj server/Axis.ReferenceProduct.Bff/packages.lock.json server/Axis.ReferenceProduct.Bff/
COPY server/Axis.ReferenceProduct.HealthProbe/Axis.ReferenceProduct.HealthProbe.csproj server/Axis.ReferenceProduct.HealthProbe/packages.lock.json server/Axis.ReferenceProduct.HealthProbe/
RUN dotnet restore server/Axis.ReferenceProduct.Bff/Axis.ReferenceProduct.Bff.csproj --locked-mode
RUN dotnet restore server/Axis.ReferenceProduct.HealthProbe/Axis.ReferenceProduct.HealthProbe.csproj --locked-mode
COPY server/Axis.ReferenceProduct.Bff/ server/Axis.ReferenceProduct.Bff/
COPY server/Axis.ReferenceProduct.HealthProbe/ server/Axis.ReferenceProduct.HealthProbe/
COPY --from=frontend /src/dist/ server/Axis.ReferenceProduct.Bff/wwwroot/
RUN dotnet publish server/Axis.ReferenceProduct.Bff/Axis.ReferenceProduct.Bff.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false
RUN dotnet publish server/Axis.ReferenceProduct.HealthProbe/Axis.ReferenceProduct.HealthProbe.csproj -c Release -o /app/health-probe --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:f1126d438ccc359f51cc6d4701a8deae513856cf10f5fe645d29ea6403dcac6b AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=https://+:4173 \
    DOTNET_RUNNING_IN_CONTAINER=true
EXPOSE 4173
COPY --from=build /app/publish ./
COPY --from=build /app/health-probe ./health-probe/
USER $APP_UID
ENTRYPOINT ["dotnet", "Axis.ReferenceProduct.Bff.dll"]
