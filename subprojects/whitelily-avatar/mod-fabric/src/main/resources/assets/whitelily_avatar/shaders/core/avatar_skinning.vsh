#version 150

in vec3 Position;
in vec3 Normal;
in vec2 UV0;
in vec4 Joints;
in vec4 Weights;

uniform mat4 ModelMat;
uniform mat4 ViewMat;
uniform mat4 ProjMat;
uniform mat4 JointMatrices[128];

out vec2 texCoord0;
out vec3 viewNormal;
out vec3 viewDirection;

void main() {
    ivec4 joint = ivec4(Joints + vec4(0.5));
    mat4 skin =
        JointMatrices[joint.x] * Weights.x +
        JointMatrices[joint.y] * Weights.y +
        JointMatrices[joint.z] * Weights.z +
        JointMatrices[joint.w] * Weights.w;
    vec4 modelPosition = ModelMat * skin * vec4(Position, 1.0);
    vec4 viewPosition = ViewMat * modelPosition;
    gl_Position = ProjMat * viewPosition;
    texCoord0 = UV0;
    viewNormal = normalize(mat3(ViewMat * ModelMat * skin) * Normal);
    viewDirection = normalize(-viewPosition.xyz);
}
