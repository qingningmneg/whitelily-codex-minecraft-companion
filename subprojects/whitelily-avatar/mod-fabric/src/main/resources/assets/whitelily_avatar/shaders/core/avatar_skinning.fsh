#version 150

uniform sampler2D Sampler0;

in vec2 texCoord0;
in vec3 viewNormal;
in vec3 viewDirection;

out vec4 fragColor;

void main() {
    vec4 base = texture(Sampler0, texCoord0);
    if (base.a < 0.01) {
        discard;
    }
    vec3 lightDirection = normalize(vec3(-0.35, 0.8, 0.45));
    float diffuse = max(dot(normalize(viewNormal), lightDirection), 0.0);
    float cel = diffuse > 0.68 ? 1.0 : (diffuse > 0.28 ? 0.76 : 0.52);
    float edge = pow(1.0 - max(dot(normalize(viewNormal), normalize(viewDirection)), 0.0), 3.0);
    vec3 boundedHighlight = vec3(0.16, 0.12, 0.2) * min(edge, 0.35);
    fragColor = vec4(base.rgb * cel + boundedHighlight, base.a);
}
